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
  it.each([false, true])(
    "dispatches once with session identity (preparation: %s)",
    async (prepared) => {
      const adapter = prepared ? createPreparingAdapter() : createAdapter();
      const build = vi.spyOn(adapter, "buildActionScript");
      const parse = vi.spyOn(adapter, "parseActionResult");
      const prepare = adapter.buildPreparationScript && vi.spyOn(adapter, "buildPreparationScript");
      const parsePreparation =
        adapter.parsePreparationResult && vi.spyOn(adapter, "parsePreparationResult");
      const response = { result: prepared ? "ready" : "test-result" };
      const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) =>
        request.path === "/tabs" ? tabs : response,
      );
      await expect(run(callBrowser, { adapter })).resolves.toEqual({
        status: "succeeded",
        observed: { sent: true },
      });
      const identity = {
        meetingSessionId: "session-1",
        meetingUrl,
        requestId: "request-1",
        action: { type: "test-action" },
      };
      expect(build).toHaveBeenCalledExactlyOnceWith(identity);
      expect(parse).toHaveBeenCalledWith(response, identity.action);
      expect(callBrowser.mock.calls.map(([request]) => [request.method, request.path])).toEqual([
        ["GET", "/tabs"],
        ...(prepared ? [["POST", "/act"]] : []),
        ["POST", "/act"],
      ]);
      expect(callBrowser.mock.calls.map(([request]) => request.body)).toEqual([
        undefined,
        ...(prepared ? [{ kind: "evaluate", targetId, fn: "() => 'prepared'" }] : []),
        { kind: "evaluate", targetId, fn: "() => 'test-result'" },
      ]);
      if (prepared) {
        expect(prepare).toHaveBeenCalledWith(identity);
        expect(parsePreparation).toHaveBeenCalledWith(response, identity.action);
      }
    },
  );

  it.each([false, true])(
    "keeps a monotonic budget (exhausted by preparation: %s)",
    async (exhausted) => {
      let monotonicNow = 1_000;
      let wallClockNow = 1_800_000_000_000;
      const monotonic = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
      const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wallClockNow);
      const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
        monotonicNow += request.path === "/tabs" ? 2_000 : exhausted ? 10_000 : 3_000;
        wallClockNow += 86_400_000;
        return request.path === "/tabs" ? tabs : { result: "ready" };
      });
      try {
        const result = await run(callBrowser, { adapter: createPreparingAdapter() });
        if (exhausted) {
          expect(result).toEqual({
            status: "failed",
            message: "Meeting participation timed out before dispatch.",
          });
        } else {
          expect(result).toMatchObject({ status: "succeeded" });
        }
        expect(callBrowser.mock.calls.map(([request]) => request.timeoutMs)).toEqual(
          exhausted ? [10_000, 8_000] : [10_000, 8_000, 5_000],
        );
      } finally {
        monotonic.mockRestore();
        wallClock.mockRestore();
      }
    },
  );

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

  it.each([
    { stage: "tab check", status: "rejected", message: "Session ended.", calls: 1 },
    { stage: "script preparation", status: "rejected", message: "Session replaced.", calls: 1 },
    { stage: "native dispatch", status: "uncertain", message: "Session ended.", calls: 2 },
  ])("revalidates authority during $stage", async ({ stage, status, message, calls }) => {
    let current = true;
    const adapter = createAdapter();
    const build = adapter.buildActionScript.bind(adapter);
    adapter.buildActionScript = (params) => {
      if (stage === "script preparation") {
        current = false;
      }
      return build(params);
    };
    const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
      await Promise.resolve();
      if (stage === (request.path === "/tabs" ? "tab check" : "native dispatch")) {
        current = false;
      }
      return request.path === "/tabs" ? tabs : { result: "test-result" };
    });
    await expect(
      run(callBrowser, {
        adapter,
        assertCurrent: () => {
          if (!current) {
            throw new Error(message);
          }
        },
      }),
    ).resolves.toEqual({ status, message });
    expect(callBrowser).toHaveBeenCalledTimes(calls);
    expect(callBrowser.mock.calls[0]?.[0].path).toBe("/tabs");
  });

  it.each([
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

  it.each(["missing parser", "rejected"])(
    "does not dispatch when preparation is %s",
    async (failure) => {
      const adapter: MeetingBrowserParticipationAdapter = {
        ...createPreparingAdapter(),
        parsePreparationResult:
          failure === "missing parser"
            ? undefined
            : () => ({ status: "rejected", message: "Meeting ended." }),
      };
      const build = vi.spyOn(adapter, "buildActionScript");
      const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async () => tabs);
      const result = await run(callBrowser, { adapter });
      if (failure === "missing parser") {
        expect(result).toMatchObject({ status: "failed" });
      } else {
        expect(result).toEqual({ status: "rejected", message: "Meeting ended." });
      }
      expect(callBrowser).toHaveBeenCalledTimes(failure === "missing parser" ? 1 : 2);
      expect(build).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    { prepared: true, failureCall: 2, status: "failed", message: "Preparation response lost." },
    { prepared: true, failureCall: 3, status: "uncertain", message: "Action response lost." },
    { prepared: false, failureCall: 2, status: "uncertain", message: "Browser response lost." },
    { prepared: false, failureCall: 1, status: "failed", message: "Browser unavailable." },
  ])(
    "records $status when browser call $failureCall fails (prepared: $prepared)",
    async ({ prepared, failureCall, status, message }) => {
      let calls = 0;
      const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) => {
        if (++calls === failureCall) {
          throw new Error(message);
        }
        return request.path === "/tabs" ? tabs : { result: "ready" };
      });
      await expect(
        run(callBrowser, { adapter: prepared ? createPreparingAdapter() : createAdapter() }),
      ).resolves.toEqual({ status, message });
      expect(callBrowser).toHaveBeenCalledTimes(failureCall);
    },
  );
});
