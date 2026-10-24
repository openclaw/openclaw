import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMeetingWithBrowser, recoverMeetingBrowserTab } from "./browser-controller.js";
import { isMeetingBrowserTransientNavigationError } from "./browser-navigation-errors.js";
import type { MeetingBrowserRequestCaller } from "./platform-adapter-contract.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const meetingUrl = "https://meet.test/meeting";

function createBrowser(onFirstEvaluation: () => void) {
  const adoption: boolean[] = [];
  const captureCaptions: boolean[] = [];
  const timeouts: number[] = [];
  const state = { evaluations: 0, adoption, captions: captureCaptions, timeouts };
  const adapter: Parameters<typeof openMeetingWithBrowser>[0]["adapter"] = {
    browserLabel: "Test meeting",
    urls: {
      accountHint: () => undefined,
      buildJoinUrl: (session) => session.url,
      isPreferredJoinUrl: () => true,
      isRecoverableTab: () => true,
      isSameMeeting: () => true,
      localeAction: () => undefined,
      normalizeForReuse: () => "test-meeting",
      validateAndNormalize: (input) => String(input),
    },
    browser: {
      allowsMicrophone: () => false,
      browserControlUnavailable: () => ({
        category: "browser-control-unavailable",
        reason: "browser-unavailable",
        message: "Browser unavailable.",
      }),
      buildLeaveScript: () => "",
      captions: {
        buildTranscriptScript: () => "",
        enabled: () => false,
        parseTranscript: () => ({ droppedLines: 0, lines: [] }),
      },
      classifyManualAction: () => undefined,
      parseLeaveResult: () => ({ departed: false }),
      parseStatus: () => ({ status: "browser-control", inCall: true }),
      permissions: () => undefined,
      permissionNotes: () => [],
      buildStatusJoinScript: (params) => {
        state.adoption.push(params.allowSessionAdoption);
        state.captions.push(params.captureCaptions);
        return "() => '{}'";
      },
    },
  };
  const callBrowser: MeetingBrowserRequestCaller = async (request) => {
    if (request.path === "/tabs") {
      return { tabs: [{ targetId: "target-1", url: meetingUrl }] };
    }
    if (request.path === "/act") {
      state.timeouts.push(request.timeoutMs);
      if (++state.evaluations === 1) {
        onFirstEvaluation();
      }
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
    expect(result.browser).toMatchObject({
      inCall: true,
      notes: ["Test meeting navigated while recovering; retrying browser inspection."],
    });
  });
});
