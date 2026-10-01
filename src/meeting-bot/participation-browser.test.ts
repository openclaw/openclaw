import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runMeetingBrowserAct } from "./browser-act-lock.js";
import { runMeetingParticipationWithBrowser } from "./participation-browser.js";
import type { MeetingBrowserParticipationAdapter } from "./participation-types.js";
import type { MeetingBrowserRequestCaller } from "./platform-adapter-contract.js";

const meetingUrl = "https://meet.test/meeting";
const targetId = "participation-target";
const tabs = { tabs: [{ targetId, url: meetingUrl }] };

function createAdapter(): MeetingBrowserParticipationAdapter {
  return {
    capabilities: ["test-action"],
    validateAction: () => undefined,
    buildActionScript: () => "() => 'test-result'",
    parseActionResult: () => ({ status: "succeeded", observed: { sent: true } }),
  };
}

function createPreparingAdapter() {
  return {
    ...createAdapter(),
    buildPreparationScript: () => "() => 'prepared'",
    parsePreparationResult: () => ({ status: "succeeded" }),
  } satisfies MeetingBrowserParticipationAdapter;
}

function run(
  callBrowser: MeetingBrowserRequestCaller,
  options: {
    assertCurrent?: () => void;
    adapter?: MeetingBrowserParticipationAdapter;
  } = {},
) {
  return runMeetingParticipationWithBrowser({
    callBrowser,
    adapter: options.adapter ?? createAdapter(),
    meetingSessionId: "session-1",
    meetingUrl,
    isSameMeetingUrl: (actual, expected) => actual === expected,
    targetId,
    requestId: "request-1",
    action: { type: "test-action" },
    assertCurrent: options.assertCurrent ?? (() => {}),
    timeoutMs: 10_000,
  });
}

describe("meeting participation browser dispatch", () => {
  it("checks the tracked tab and dispatches once with the session and request identity", async () => {
    const adapter = createAdapter();
    const build = vi.spyOn(adapter, "buildActionScript");
    const parse = vi.spyOn(adapter, "parseActionResult");
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) =>
      request.path === "/tabs" ? tabs : { result: "test-result" },
    );

    await expect(run(callBrowser, { adapter })).resolves.toEqual({
      status: "succeeded",
      observed: { sent: true },
    });
    expect(callBrowser.mock.calls.map(([request]) => [request.method, request.path])).toEqual([
      ["GET", "/tabs"],
      ["POST", "/act"],
    ]);
    expect(callBrowser.mock.calls[1]?.[0].body).toEqual({
      kind: "evaluate",
      targetId,
      fn: "() => 'test-result'",
    });
    expect(build).toHaveBeenCalledWith({
      meetingSessionId: "session-1",
      meetingUrl,
      requestId: "request-1",
      action: { type: "test-action" },
    });
    expect(parse).toHaveBeenCalledWith({ result: "test-result" }, { type: "test-action" });
  });

  it.each([86_400_000, -86_400_000])(
    "keeps one monotonic budget when the wall clock jumps by %i ms",
    async (wallClockJump) => {
      let monotonicNow = 1_000;
      let wallClockNow = 1_800_000_000_000;
      const monotonic = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
      const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wallClockNow);
      const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
        monotonicNow += request.path === "/tabs" ? 2_000 : 3_000;
        wallClockNow += wallClockJump;
        return request.path === "/tabs" ? tabs : { result: "ready" };
      });
      try {
        await expect(
          run(callBrowser, { adapter: createPreparingAdapter() }),
        ).resolves.toMatchObject({
          status: "succeeded",
        });
        expect(callBrowser.mock.calls.map(([request]) => request.timeoutMs)).toEqual([
          10_000, 8_000, 5_000,
        ]);
      } finally {
        monotonic.mockRestore();
        wallClock.mockRestore();
      }
    },
  );

  it("does not dispatch after preparation exhausts the monotonic budget", async () => {
    let monotonicNow = 1_000;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
      if (request.path === "/act") {
        monotonicNow += 10_000;
      }
      return request.path === "/tabs" ? tabs : { result: "ready" };
    });
    try {
      await expect(run(callBrowser, { adapter: createPreparingAdapter() })).resolves.toEqual({
        status: "failed",
        message: "Meeting participation timed out before dispatch.",
      });
      expect(callBrowser).toHaveBeenCalledTimes(2);
    } finally {
      monotonic.mockRestore();
    }
  });

  it.each([
    { capabilities: [], expected: "unsupported" },
    { capabilities: ["test-action"], expected: "rejected" },
  ])("does not dispatch an $expected action", async ({ capabilities, expected }) => {
    const adapter = { ...createAdapter(), capabilities, validateAction: () => "Invalid action." };
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>();
    await expect(run(callBrowser, { adapter })).resolves.toMatchObject({ status: expected });
    expect(callBrowser).not.toHaveBeenCalled();
  });

  it("uses the existing browser lock and rejects a session that leaves while queued", async () => {
    const { promise: gate, resolve: release } = createDeferredCore();
    const blocker = runMeetingBrowserAct({
      targetId,
      deadline: performance.now() + 10_000,
      operation: async () => await gate,
    });
    let current = true;
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async () => tabs);
    const result = run(callBrowser, {
      assertCurrent: () => {
        if (!current) {
          throw new Error("Session ended.");
        }
      },
    });
    await Promise.resolve();
    expect(callBrowser).not.toHaveBeenCalled();
    current = false;
    release?.();
    await blocker;
    await expect(result).resolves.toEqual({ status: "rejected", message: "Session ended." });
    expect(callBrowser).not.toHaveBeenCalled();
  });

  it("rejects a session that leaves while the tab check is pending", async () => {
    let current = true;
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async () => {
      await Promise.resolve();
      current = false;
      return tabs;
    });
    await expect(
      run(callBrowser, {
        assertCurrent: () => {
          if (!current) {
            throw new Error("Session ended.");
          }
        },
      }),
    ).resolves.toEqual({ status: "rejected", message: "Session ended." });
    expect(callBrowser).toHaveBeenCalledTimes(1);
    expect(callBrowser.mock.calls[0]?.[0].path).toBe("/tabs");
  });

  it.each([
    { tabList: [] },
    { tabList: [{ targetId: "another-target", url: meetingUrl }] },
    { tabList: [{ targetId, url: "https://meet.test/another-meeting" }] },
  ])(
    "does not recover another tab when the tracked meeting is missing: $tabList",
    async ({ tabList }) => {
      const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async () => ({ tabs: tabList }));
      await expect(run(callBrowser)).resolves.toMatchObject({ status: "rejected" });
      expect(callBrowser).toHaveBeenCalledTimes(1);
      expect(callBrowser.mock.calls[0]?.[0].path).toBe("/tabs");
    },
  );

  it("does not dispatch after authority changes during script preparation", async () => {
    let current = true;
    const adapter = {
      ...createAdapter(),
      buildActionScript: () => {
        current = false;
        return "() => 'test-result'";
      },
    };
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async () => tabs);
    await expect(
      run(callBrowser, {
        adapter,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Session replaced.");
          }
        },
      }),
    ).resolves.toEqual({ status: "rejected", message: "Session replaced." });
    expect(callBrowser).toHaveBeenCalledTimes(1);
  });

  it("verifies native preparation before dispatching the requested action", async () => {
    const adapter = createPreparingAdapter();
    const prepare = vi.spyOn(adapter, "buildPreparationScript");
    const parsePreparation = vi.spyOn(adapter, "parsePreparationResult");
    const build = vi.spyOn(adapter, "buildActionScript");
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) =>
      request.path === "/tabs" ? tabs : { result: "ready" },
    );

    await expect(run(callBrowser, { adapter })).resolves.toMatchObject({ status: "succeeded" });
    expect(prepare).toHaveBeenCalledWith({
      meetingSessionId: "session-1",
      meetingUrl,
      requestId: "request-1",
      action: { type: "test-action" },
    });
    expect(parsePreparation).toHaveBeenCalledWith({ result: "ready" }, { type: "test-action" });
    expect(build).toHaveBeenCalledTimes(1);
    expect(callBrowser.mock.calls.map(([request]) => request.body)).toEqual([
      undefined,
      { kind: "evaluate", targetId, fn: "() => 'prepared'" },
      { kind: "evaluate", targetId, fn: "() => 'test-result'" },
    ]);
  });

  it("does not request native preparation without a result parser", async () => {
    const adapter = { ...createAdapter(), buildPreparationScript: () => "() => 'prepared'" };
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async () => tabs);
    await expect(run(callBrowser, { adapter })).resolves.toMatchObject({ status: "failed" });
    expect(callBrowser).toHaveBeenCalledTimes(1);
  });

  it("does not perform an action when native preparation rejects it", async () => {
    const adapter: MeetingBrowserParticipationAdapter = {
      ...createPreparingAdapter(),
      parsePreparationResult: () => ({ status: "rejected", message: "Meeting ended." }),
    };
    const build = vi.spyOn(adapter, "buildActionScript");
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async () => tabs);
    await expect(run(callBrowser, { adapter })).resolves.toEqual({
      status: "rejected",
      message: "Meeting ended.",
    });
    expect(callBrowser).toHaveBeenCalledTimes(2);
    expect(build).not.toHaveBeenCalled();
  });

  it("rejects a session that leaves during preparation while retaining the browser lock", async () => {
    const { promise: gate, resolve: release } = createDeferredCore();
    const { promise: preparing, resolve: markPreparing } = createDeferredCore();
    let current = true;
    const adapter = createPreparingAdapter();
    const build = vi.spyOn(adapter, "buildActionScript");
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
      if (request.path === "/tabs") {
        return tabs;
      }
      markPreparing?.();
      await gate;
      return { result: "ready" };
    });
    const result = run(callBrowser, {
      adapter,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Session ended.");
        }
      },
    });
    await preparing;
    const concurrentOperation = vi.fn(async () => {});
    const concurrent = runMeetingBrowserAct({
      targetId,
      deadline: performance.now() + 10_000,
      operation: concurrentOperation,
    });
    await Promise.resolve();
    expect(concurrentOperation).not.toHaveBeenCalled();
    current = false;
    release?.();
    await expect(result).resolves.toEqual({ status: "rejected", message: "Session ended." });
    await concurrent;
    expect(concurrentOperation).toHaveBeenCalledTimes(1);
    expect(callBrowser).toHaveBeenCalledTimes(2);
    expect(build).not.toHaveBeenCalled();
  });

  it("records failure without a requested effect if native preparation throws", async () => {
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
      if (request.path === "/tabs") {
        return tabs;
      }
      throw new Error("Preparation response lost.");
    });
    await expect(run(callBrowser, { adapter: createPreparingAdapter() })).resolves.toEqual({
      status: "failed",
      message: "Preparation response lost.",
    });
    expect(callBrowser).toHaveBeenCalledTimes(2);
  });

  it("records uncertainty if a prepared action loses its final browser response", async () => {
    let actCalls = 0;
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
      if (request.path === "/tabs") {
        return tabs;
      }
      actCalls += 1;
      if (actCalls === 1) {
        return { result: "ready" };
      }
      throw new Error("Action response lost.");
    });
    await expect(run(callBrowser, { adapter: createPreparingAdapter() })).resolves.toEqual({
      status: "uncertain",
      message: "Action response lost.",
    });
    expect(callBrowser).toHaveBeenCalledTimes(3);
  });

  it("records an uncertain result after an attempted native dispatch throws", async () => {
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
      if (request.path === "/tabs") {
        return tabs;
      }
      throw new Error("Browser response lost.");
    });
    await expect(run(callBrowser)).resolves.toEqual({
      status: "uncertain",
      message: "Browser response lost.",
    });
    expect(callBrowser).toHaveBeenCalledTimes(2);
  });

  it("records failure without a native dispatch if the tab check throws", async () => {
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async () => {
      throw new Error("Browser unavailable.");
    });
    await expect(run(callBrowser)).resolves.toEqual({
      status: "failed",
      message: "Browser unavailable.",
    });
    expect(callBrowser).toHaveBeenCalledTimes(1);
  });

  it("records an uncertain result when the session ends during native dispatch", async () => {
    let current = true;
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
      if (request.path === "/tabs") {
        return tabs;
      }
      current = false;
      return { result: "test-result" };
    });
    await expect(
      run(callBrowser, {
        assertCurrent: () => {
          if (!current) {
            throw new Error("Session ended.");
          }
        },
      }),
    ).resolves.toEqual({ status: "uncertain", message: "Session ended." });
    expect(callBrowser).toHaveBeenCalledTimes(2);
  });
});
