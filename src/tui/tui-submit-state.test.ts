import { describe, expect, it } from "vitest";
import {
  acceptPendingSubmit,
  beginPendingSubmit,
  clearPendingSubmit,
  clearPendingSubmitDraft,
  getPendingSubmitAcceptedRunId,
  getPendingSubmitDraft,
  reconcilePendingSubmitHistory,
  resolveTuiChatSubmitAdmission,
  tuiSessionActionBlockedMessage,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";

type State = { pendingSubmit: TuiPendingSubmit | null };
const sending = { phase: "sending", runId: "run-local", draftText: "hello" } as const;
const accepted = { ...sending, phase: "accepted", runId: "run-accepted" } as const;
const registered = { ...accepted, draftText: null };
const accept = (state: State) =>
  acceptPendingSubmit({
    state,
    provisionalRunId: "run-local",
    acceptedRunId: "run-accepted",
    preserveDraft: true,
  });

describe("resolveTuiChatSubmitAdmission", () => {
  it.each([
    ["idle", true, null, "hello", { status: "allowed" }],
    ["disconnected", false, null, "hello", { status: "blocked", reason: "disconnected" }],
    ["sending", true, sending, "another", { status: "blocked", reason: "pending" }],
    ["stop accepted run", true, registered, "please stop", { status: "allowed" }],
  ] as const)(
    "resolves admission while %s",
    (_name, isConnected, pendingSubmit, message, expected) => {
      expect(
        resolveTuiChatSubmitAdmission({
          isConnected,
          pendingSubmit,
          message,
          activeChatRunId: null,
          historyLoaded: true,
          transition: { active: null, boundary: null, epoch: 0 },
          allowDuringPending: false,
        }),
      ).toEqual(expected);
    },
  );
});

describe("pending submit transitions", () => {
  it("moves one submit through sending, accepted, registered, and reconciled states", () => {
    const state: State = { pendingSubmit: null };

    beginPendingSubmit(state, "run-local", "hello");
    expect(state.pendingSubmit).toEqual(sending);
    expect(getPendingSubmitAcceptedRunId(state)).toBeNull();
    expect(getPendingSubmitDraft(state)).toEqual({ runId: "run-local", text: "hello" });

    expect(accept(state)).toBe(true);
    expect(state.pendingSubmit).toEqual(accepted);
    expect(getPendingSubmitAcceptedRunId(state)).toBe("run-accepted");

    expect(clearPendingSubmitDraft(state, "run-accepted")).toBe(true);
    expect(state.pendingSubmit).toEqual(registered);
    expect(reconcilePendingSubmitHistory(state, ["other-run"])).toBe(false);
    expect(reconcilePendingSubmitHistory(state, ["run-accepted"])).toBe(true);
    expect(state.pendingSubmit).toBeNull();
  });

  it("does not re-arm a submit cleared by an event before its ACK", () => {
    const state: State = { pendingSubmit: null };
    beginPendingSubmit(state, "run-local", "hello");
    expect(clearPendingSubmit(state, "run-local")).toBe(true);

    expect(accept(state)).toBe(false);
    expect(state.pendingSubmit).toBeNull();
  });

  it("keeps draft ownership while a submit is still sending", () => {
    const state: State = {
      pendingSubmit: { phase: "sending", runId: "run-sending", draftText: "hello" },
    };

    expect(clearPendingSubmitDraft(state, "run-sending")).toBe(false);
    expect(state.pendingSubmit?.draftText).toBe("hello");
  });

  it("clears only the run that owns the pending state", () => {
    const state: State = {
      pendingSubmit: { phase: "accepted", runId: "run-current", draftText: "hello" },
    };

    expect(clearPendingSubmit(state, "run-other")).toBe(false);
    expect(state.pendingSubmit?.runId).toBe("run-current");
  });
});

describe("tuiSessionActionBlockedMessage", () => {
  it("uses the connection message for the selected runtime", () => {
    expect(
      tuiSessionActionBlockedMessage({ status: "blocked", reason: "disconnected" }, false),
    ).toBe("not connected to gateway — message not sent");
    expect(
      tuiSessionActionBlockedMessage({ status: "blocked", reason: "disconnected" }, true),
    ).toBe("local runtime not ready — message not sent");
  });
});
