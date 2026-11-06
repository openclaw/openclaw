import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runMeetingBrowserAct } from "./browser-act-lock.js";
import { runMeetingParticipationWithBrowser } from "./participation-browser.js";
import type { MeetingBrowserParticipationAdapter } from "./participation-types.js";
import type { MeetingBrowserRequestCaller } from "./platform-adapter-contract.js";

const meetingUrl = "https://meet.test/meeting";
const targetId = "participation-target";
const tabs = { tabs: [{ targetId, url: meetingUrl }] };
const identity = {
  meetingSessionId: "session-1",
  meetingUrl,
  requestId: "request-1",
  action: { type: "test-action" },
};
let adapter: MeetingBrowserParticipationAdapter;
let callBrowser: ReturnType<typeof vi.fn<MeetingBrowserRequestCaller>>;
let authority: { current: boolean; message: string };

function createAdapter(prepared = false): MeetingBrowserParticipationAdapter {
  const result: MeetingBrowserParticipationAdapter = {
    capabilities: ["test-action"],
    validateAction: () => undefined,
    buildActionScript: () => "() => 'test-result'",
    parseActionResult: () => ({ status: "succeeded", observed: { sent: true } }),
  };
  if (prepared) {
    result.buildPreparationScript = () => "() => 'prepared'";
    result.parsePreparationResult = () => ({ status: "succeeded" });
  }
  return result;
}
beforeEach(() => {
  authority = { current: true, message: "Session ended." };
  adapter = createAdapter();
  callBrowser = vi.fn<MeetingBrowserRequestCaller>(async (request) =>
    request.path === "/tabs" ? tabs : { result: "ready" },
  );
});
afterEach(() => vi.restoreAllMocks());

function run() {
  return runMeetingParticipationWithBrowser({
    ...identity,
    callBrowser,
    adapter,
    targetId,
    timeoutMs: 10_000,
    isSameMeetingUrl: (actual, expected) => actual === expected,
    assertCurrent: () => {
      if (!authority.current) {
        throw new Error(authority.message);
      }
    },
  });
}
function lock(operation: () => Promise<void>) {
  return runMeetingBrowserAct({ targetId, deadline: performance.now() + 10_000, operation });
}

describe("meeting participation browser dispatch", () => {
  it.each([false, true])("dispatches once with identity (prepared: %s)", async (prepared) => {
    adapter = createAdapter(prepared);
    const build = vi.spyOn(adapter, "buildActionScript");
    const prepare = adapter.buildPreparationScript && vi.spyOn(adapter, "buildPreparationScript");
    const response = { result: prepared ? "ready" : "test-result" };
    callBrowser.mockImplementation(async (request) => (request.path === "/tabs" ? tabs : response));
    await expect(run()).resolves.toEqual({ status: "succeeded", observed: { sent: true } });
    expect(build).toHaveBeenCalledExactlyOnceWith(identity);
    const act = (fn: string) => ["POST", "/act", { kind: "evaluate", targetId, fn }];
    expect(callBrowser.mock.calls.map(([{ method, path, body }]) => [method, path, body])).toEqual([
      ["GET", "/tabs", undefined],
      ...(prepared ? [act("() => 'prepared'")] : []),
      act("() => 'test-result'"),
    ]);
    if (prepared) {
      expect(prepare).toHaveBeenCalledWith(identity);
    }
  });

  it.each([false, true])("uses monotonic budgets (exhausted: %s)", async (exhausted) => {
    let monotonicNow = 1_000;
    let wallClockNow = 1_800_000_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    vi.spyOn(Date, "now").mockImplementation(() => wallClockNow);
    callBrowser.mockImplementation(async (request) => {
      monotonicNow += request.path === "/tabs" ? 2_000 : exhausted ? 10_000 : 3_000;
      wallClockNow += 86_400_000;
      return request.path === "/tabs" ? tabs : { result: "ready" };
    });
    adapter = createAdapter(true);
    const result = await run();
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
  });

  it.each([
    { capabilities: [], expected: "unsupported" },
    { capabilities: ["test-action"], expected: "rejected" },
  ])("does not dispatch an $expected action", async ({ capabilities, expected }) => {
    adapter.capabilities = capabilities;
    adapter.validateAction = () => "Invalid action.";
    await expect(run()).resolves.toMatchObject({ status: expected });
    expect(callBrowser).not.toHaveBeenCalled();
  });

  it("rechecks queued sessions under the browser lock", async () => {
    const { promise: gate, resolve: release } = createDeferredCore();
    const blocker = lock(async () => await gate);
    const result = run();
    await Promise.resolve();
    expect(callBrowser).not.toHaveBeenCalled();
    authority.current = false;
    release?.();
    await blocker;
    await expect(result).resolves.toEqual({ status: "rejected", message: "Session ended." });
    expect(callBrowser).not.toHaveBeenCalled();
  });

  it.each([
    { stage: "tab check", status: "rejected", message: "Session ended.", calls: 1 },
    { stage: "script build", status: "rejected", message: "Session replaced.", calls: 1 },
    { stage: "dispatch", status: "uncertain", message: "Session ended.", calls: 2 },
  ])("revalidates authority during $stage", async ({ stage, status, message, calls }) => {
    authority.message = message;
    const build = adapter.buildActionScript.bind(adapter);
    adapter.buildActionScript = (params) => {
      if (stage === "script build") {
        authority.current = false;
      }
      return build(params);
    };
    callBrowser.mockImplementation(async (request) => {
      await Promise.resolve();
      if (stage === (request.path === "/tabs" ? "tab check" : "dispatch")) {
        authority.current = false;
      }
      return request.path === "/tabs" ? tabs : { result: "test-result" };
    });
    await expect(run()).resolves.toEqual({ status, message });
    expect(callBrowser).toHaveBeenCalledTimes(calls);
    expect(callBrowser.mock.calls[0]?.[0].path).toBe("/tabs");
  });

  it.each([
    { tabList: [{ targetId: "another-target", url: meetingUrl }] },
    { tabList: [{ targetId, url: "https://meet.test/another-meeting" }] },
  ])("rejects a missing tracked meeting: $tabList", async ({ tabList }) => {
    callBrowser.mockResolvedValue({ tabs: tabList });
    await expect(run()).resolves.toMatchObject({ status: "rejected" });
    expect(callBrowser).toHaveBeenCalledTimes(1);
    expect(callBrowser.mock.calls[0]?.[0].path).toBe("/tabs");
  });

  it.each(["missing parser", "rejected"])("stops when preparation is %s", async (failure) => {
    adapter = createAdapter(true);
    adapter.parsePreparationResult =
      failure === "missing parser"
        ? undefined
        : () => ({ status: "rejected", message: "Meeting ended." });
    const build = vi.spyOn(adapter, "buildActionScript");
    callBrowser.mockResolvedValue(tabs);
    const result = await run();
    if (failure === "missing parser") {
      expect(result).toMatchObject({ status: "failed" });
    } else {
      expect(result).toEqual({ status: "rejected", message: "Meeting ended." });
    }
    expect(callBrowser).toHaveBeenCalledTimes(failure === "missing parser" ? 1 : 2);
    expect(build).not.toHaveBeenCalled();
  });

  it("retains the browser lock until preparation loses authority", async () => {
    const { promise: gate, resolve: release } = createDeferredCore();
    const { promise: preparing, resolve: markPreparing } = createDeferredCore();
    adapter = createAdapter(true);
    const build = vi.spyOn(adapter, "buildActionScript");
    callBrowser.mockImplementation(async (request) => {
      if (request.path === "/tabs") {
        return tabs;
      }
      markPreparing?.();
      await gate;
      return { result: "ready" };
    });
    const result = run();
    await preparing;
    const concurrentOperation = vi.fn(async () => {});
    const concurrent = lock(concurrentOperation);
    await Promise.resolve();
    expect(concurrentOperation).not.toHaveBeenCalled();
    authority.current = false;
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
    "$status: call $failureCall ($prepared)",
    async ({ prepared, failureCall, status, message }) => {
      let calls = 0;
      adapter = createAdapter(prepared);
      callBrowser.mockImplementation(async (request) => {
        if (++calls === failureCall) {
          throw new Error(message);
        }
        return request.path === "/tabs" ? tabs : { result: "ready" };
      });
      await expect(run()).resolves.toEqual({ status, message });
      expect(callBrowser).toHaveBeenCalledTimes(failureCall);
    },
  );
});
