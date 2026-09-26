import { runMeetingBrowserAct } from "./browser-act-lock.js";
import { asMeetingBrowserTabs } from "./browser-request.js";
import type {
  MeetingBrowserParticipationAdapter,
  MeetingParticipationAction,
  MeetingParticipationEffectResult,
} from "./participation-types.js";
import type { MeetingBrowserRequestCaller } from "./platform-adapter-contract.js";

// The adapter must recheck the session marker and meeting URL in the page
// immediately before each native effect. Preparation may await UI readiness but
// must not perform the requested action. The final script must perform that
// action without yielding first; it may await observation afterward, not another
// effect. This lets the owner revalidate after preparation has yielded.
export async function runMeetingParticipationWithBrowser(params: {
  callBrowser: MeetingBrowserRequestCaller;
  adapter: MeetingBrowserParticipationAdapter;
  meetingSessionId: string;
  meetingUrl: string;
  isSameMeetingUrl: (actual: string | undefined, expected: string) => boolean;
  targetId: string;
  requestId: string;
  action: MeetingParticipationAction;
  assertCurrent: () => void;
  timeoutMs: number;
}): Promise<MeetingParticipationEffectResult> {
  let dispatched = false;
  let authorityCheckFailed = false;
  const assertCurrent = () => {
    try {
      params.assertCurrent();
    } catch (error) {
      authorityCheckFailed = true;
      throw error;
    }
  };
  try {
    assertCurrent();
    if (!params.adapter.capabilities.includes(params.action.type)) {
      return { status: "unsupported", message: "This meeting does not support that action." };
    }
    const invalidAction = params.adapter.validateAction(params.action);
    if (invalidAction) {
      return { status: "rejected", message: invalidAction };
    }
    const deadline = performance.now() + Math.max(1, params.timeoutMs);
    const result = await runMeetingBrowserAct({
      deadline,
      targetId: params.targetId,
      operation: async (remainingMs) => {
        assertCurrent();
        const tabs = asMeetingBrowserTabs(
          await params.callBrowser({ method: "GET", path: "/tabs", timeoutMs: remainingMs }),
        );
        assertCurrent();
        const tab = tabs.find((entry) => entry.targetId === params.targetId);
        if (!tab || !params.isSameMeetingUrl(tab.url, params.meetingUrl)) {
          return {
            status: "rejected" as const,
            message: "The tracked browser tab no longer shows this meeting; no action was sent.",
          };
        }
        const scriptParams = {
          meetingSessionId: params.meetingSessionId,
          meetingUrl: params.meetingUrl,
          requestId: params.requestId,
          action: params.action,
        };
        const remainingTimeoutMs = () => {
          const timeoutMs = Math.floor(deadline - performance.now());
          if (timeoutMs <= 0) {
            throw new Error("Meeting participation timed out before dispatch.");
          }
          return timeoutMs;
        };
        if (params.adapter.buildPreparationScript) {
          if (!params.adapter.parsePreparationResult) {
            return {
              status: "failed" as const,
              message: "The meeting adapter cannot verify action preparation.",
            };
          }
          const fn = params.adapter.buildPreparationScript(scriptParams);
          const timeoutMs = remainingTimeoutMs();
          assertCurrent();
          const prepared = await params.callBrowser({
            method: "POST",
            path: "/act",
            body: { kind: "evaluate", targetId: params.targetId, fn },
            timeoutMs,
          });
          assertCurrent();
          const preparation = params.adapter.parsePreparationResult(prepared, params.action);
          if (preparation.status !== "succeeded") {
            return preparation;
          }
        }
        const fn = params.adapter.buildActionScript(scriptParams);
        const timeoutMs = remainingTimeoutMs();
        assertCurrent();
        dispatched = true;
        const evaluated = await params.callBrowser({
          method: "POST",
          path: "/act",
          body: { kind: "evaluate", targetId: params.targetId, fn },
          timeoutMs,
        });
        assertCurrent();
        return params.adapter.parseActionResult(evaluated, params.action);
      },
    });
    assertCurrent();
    return result;
  } catch (error) {
    return {
      status: dispatched ? "uncertain" : authorityCheckFailed ? "rejected" : "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
