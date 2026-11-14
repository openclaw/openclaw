import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runMeetingBrowserAct } from "./browser-act-lock.js";
import { openMeetingWithBrowser, recoverMeetingBrowserTab } from "./browser-controller.js";
import { isMeetingBrowserTransientNavigationError } from "./browser-navigation-errors.js";
import { leaveMeetingWithBrowser } from "./browser-session-control.js";
import { TEST_MEETING_PLATFORM_ADAPTER } from "./observation-provenance.test-support.js";
import type {
  MeetingBrowserLeaveStep,
  MeetingBrowserRequestCaller,
} from "./platform-adapter-contract.js";

afterEach(() => vi.useRealTimers());
const meetingUrl = "https://meet.test/meeting";
type LeaveOptions = {
  openedByPlugin?: boolean;
  buildSessionLeaveScript?: Parameters<
    typeof leaveMeetingWithBrowser
  >[0]["adapter"]["browser"]["buildSessionLeaveScript"];
  onDelete?: () => Promise<void>;
};

function createBrowser(
  onFirstEvaluation: () => void,
  leave?: LeaveOptions & { steps: MeetingBrowserLeaveStep[] },
) {
  const adoption: boolean[] = [];
  const captureCaptions: boolean[] = [];
  const timeouts: number[] = [];
  const deletedTabs: string[] = [];
  const state = { evaluations: 0, adoption, captions: captureCaptions, timeouts, deletedTabs };
  const adapter: Parameters<typeof openMeetingWithBrowser>[0]["adapter"] = {
    ...TEST_MEETING_PLATFORM_ADAPTER,
    browser: {
      ...TEST_MEETING_PLATFORM_ADAPTER.browser,
      captions: {
        ...TEST_MEETING_PLATFORM_ADAPTER.browser.captions,
        enabled: () => false,
      },
      parseStatus: () => ({ status: "browser-control", inCall: true }),
      buildSessionLeaveScript: leave?.buildSessionLeaveScript,
      parseLeaveResult: () =>
        leave?.steps[Math.min(state.evaluations - 1, leave.steps.length - 1)] ?? {
          departed: false,
        },
      permissionNotes: () => [],
      buildStatusJoinScript: (params) => {
        state.adoption.push(params.allowSessionAdoption);
        state.captions.push(params.captureCaptions);
        return "() => '{}'";
      },
    },
  };
  const callBrowser: MeetingBrowserRequestCaller = async (request) => {
    if (request.method === "DELETE") {
      deletedTabs.push(request.path);
      await leave?.onDelete?.();
      return {};
    }
    if (request.path === "/tabs") {
      return { tabs: [{ targetId: "target-1", url: meetingUrl }] };
    }
    if (request.path === "/act") {
      state.timeouts.push(request.timeoutMs);
      if (++state.evaluations === 1) {
        onFirstEvaluation();
      }
    }
    if (leave && request.path !== "/act") {
      throw new Error(`Unexpected browser request: ${request.method} ${request.path}`);
    }
    return {};
  };
  return { adapter, callBrowser, state };
}

function makeConfig(timeoutMs: number) {
  return {
    launch: true,
    reuseExistingTab: true,
    autoJoin: true,
    guestName: "OpenClaw QA",
    joinTimeoutMs: timeoutMs,
    waitForInCallMs: timeoutMs,
  };
}

describe("meeting browser", () => {
  beforeEach(() => vi.useFakeTimers());
  it.each([
    ["Protocol error: Cannot find context with specified id", true],
    ["browser unavailable", false],
  ] as const)("classifies navigation failure %s as transient=%s", (message, transient) => {
    expect(isMeetingBrowserTransientNavigationError(new Error(message))).toBe(transient);
  });
  it("retries a platform-owned transient in-call status across a wall-clock jump", async () => {
    const { adapter, callBrowser, state } = createBrowser(() =>
      vi.setSystemTime(Date.now() + 60_000),
    );
    const manualAction = { reason: "audio-choice", message: "Wait." };
    adapter.browser = {
      ...adapter.browser,
      allowsMicrophone: () => true,
      captions: { ...adapter.browser.captions, enabled: () => true },
      classifyManualAction: (health) =>
        health.manualAction && { category: "audio-choice-required", ...manualAction },
      parseStatus: () => ({
        inCall: true,
        micMuted: false,
        ...(state.evaluations === 1 ? { manualAction } : {}),
      }),
      shouldRetryJoinStatus: (health) => health.manualAction?.reason === "audio-choice",
    };
    const joining = openMeetingWithBrowser({
      adapter,
      callBrowser,
      config: makeConfig(1_000),
      session: {
        captureCaptions: false,
        meetingSessionId: "session-1",
        mode: "agent",
        url: meetingUrl,
      },
    });
    await vi.advanceTimersByTimeAsync(750);
    const result = await joining;

    expect(state.evaluations).toBe(2);
    expect(state.adoption).toEqual([true, false]);
    expect(state.captions).toEqual([false, false]);
    expect(result.browser).toMatchObject({ inCall: true, micMuted: false });
  });
  it("keeps navigation recovery within its budget across a wall-clock rollback", async () => {
    const { adapter, callBrowser, state } = createBrowser(() => {
      vi.setSystemTime(Date.now() - 60_000);
      throw new Error("page.evaluate: Execution context was destroyed because of navigation");
    });
    const recovering = recoverMeetingBrowserTab({
      adapter,
      allowSessionAdoption: true,
      autoJoin: true,
      callBrowser,
      config: makeConfig(2_000),
      locationLabel: "for testing",
      meetingSessionId: "session-1",
      mode: "listen",
      requestedMeetingUrl: meetingUrl,
      timeoutMs: 500,
      trackedMeetingUrl: meetingUrl,
      trackedTargetId: "target-1",
    });
    await vi.advanceTimersByTimeAsync(250);
    const result = await recovering;

    expect(state.evaluations).toBe(2);
    expect(state.adoption).toEqual([true, false]);
    expect(state.timeouts[0]).toBeLessThanOrEqual(500);
    expect(state.timeouts[1]).toBeLessThan(state.timeouts[0] ?? 0);
    expect(result.browser?.inCall).toBe(true);
    expect(result.browser?.notes).toEqual([expect.stringContaining("navigated while recovering")]);
  });
});

function startLeaving(steps: MeetingBrowserLeaveStep[], options: LeaveOptions = {}) {
  const { adapter, callBrowser, state } = createBrowser(() => {}, { steps, ...options });
  const leaving = leaveMeetingWithBrowser({
    adapter,
    callBrowser,
    launch: true,
    meetingSessionId: "session-1",
    meetingUrl,
    tab: { targetId: "target-1", openedByPlugin: options.openedByPlugin ?? true },
    timeoutMs: 1_000,
  });
  return { leaving, deletedTabs: state.deletedTabs };
}

describe("meeting browser leave ownership", () => {
  it.each([
    [
      { departed: false, sessionConflict: true, sessionMatched: false },
      true,
      true,
      "belongs to another OpenClaw meeting session",
    ],
    [{ departed: false, sessionMatched: false }, true, false, "could not verify"],
    [{ departed: true }, false, true, "kept the reused browser tab open"],
  ] as const)(
    "keeps tab ownership for %j (plugin=%s, left=%s)",
    async (step, openedByPlugin, left, note) => {
      const { leaving, deletedTabs } = startLeaving([{ ...step, urlMatched: true }], {
        openedByPlugin,
      });
      await expect(leaving).resolves.toEqual({ left, note: expect.stringContaining(note) });
      expect(deletedTabs).toEqual([]);
    },
  );

  it("carries initiated-leave evidence into the next page evaluation", async () => {
    const leaveInitiated: boolean[] = [];
    const deleteStarted = createDeferredCore();
    const deleteGate = createDeferredCore();
    const { leaving, deletedTabs } = startLeaving(
      [
        { departed: false, leaveAction: "leave", urlMatched: true },
        { departed: false, sessionMatched: false, urlMatched: true },
        { departed: true, urlMatched: false },
      ],
      {
        buildSessionLeaveScript: (context) => {
          leaveInitiated.push(context.leaveInitiated);
          return "() => '{}'";
        },
        onDelete: async () => {
          deleteStarted.resolve();
          await deleteGate.promise;
        },
      },
    );
    await deleteStarted.promise;
    let concurrentStarted = false;
    const concurrent = runMeetingBrowserAct({
      deadline: performance.now() + 1_000,
      targetId: "target-1",
      operation: async () => {
        concurrentStarted = true;
      },
    });
    await Promise.resolve();
    expect(concurrentStarted).toBe(false);
    deleteGate.resolve();
    const result = await leaving;
    await concurrent;
    expect(leaveInitiated).toEqual([false, true, true]);
    expect(deletedTabs).toEqual(["/tabs/target-1"]);
    expect(concurrentStarted).toBe(true);
    expect(result.left).toBe(true);
  });

  it("reserves enough time to close a plugin tab after leave polling expires", async () => {
    vi.useFakeTimers();
    const { leaving, deletedTabs } = startLeaving([
      { departed: false, leaveAction: "leave", urlMatched: true },
      { departed: false, urlMatched: true },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await leaving;
    expect(deletedTabs).toEqual(["/tabs/target-1"]);
    expect(result.left).toBe(true);
  });
});
