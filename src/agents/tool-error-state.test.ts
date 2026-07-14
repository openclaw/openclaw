import { describe, expect, it } from "vitest";
import { mergeUnresolvedMutationError, resolveSuccessfulToolMutation } from "./tool-error-state.js";

describe("unresolved tool mutation errors", () => {
  it("retains action A after action B fails and then succeeds", () => {
    const actionA = {
      toolName: "message",
      error: "send A failed",
      mutatingAction: true,
      actionFingerprint: "tool=message|action=send|to=channel:a",
    } as const;
    const actionB = {
      toolName: "message",
      error: "send B failed",
      mutatingAction: true,
      actionFingerprint: "tool=message|action=send|to=channel:b",
    } as const;

    const bothFailed = mergeUnresolvedMutationError(
      actionB,
      mergeUnresolvedMutationError(actionA, undefined),
    );
    expect(bothFailed).toMatchObject({
      actionFingerprint: actionB.actionFingerprint,
    });
    expect(Object.keys(bothFailed)).not.toContain("unresolvedMutations");
    expect(JSON.stringify(bothFailed)).not.toContain(actionA.error);

    const afterBRecovers = resolveSuccessfulToolMutation({ ...bothFailed }, actionB);
    expect(afterBRecovers).toMatchObject({
      actionFingerprint: actionA.actionFingerprint,
      error: actionA.error,
    });
    expect(resolveSuccessfulToolMutation(afterBRecovers, actionA)).toBeUndefined();
  });

  it("updates repeated failures for the same action without duplicating state", () => {
    const first = {
      toolName: "write",
      error: "first failure",
      mutatingAction: true,
      actionFingerprint: "tool=write|path=/tmp/a",
    } as const;
    const latest = { ...first, error: "latest failure" };

    expect(
      mergeUnresolvedMutationError(latest, mergeUnresolvedMutationError(first, undefined)),
    ).toEqual(latest);
  });

  it("moves a repeated action failure to the latest public position", () => {
    const actionA = {
      toolName: "message",
      error: "A failed again",
      mutatingAction: true,
      actionFingerprint: "tool=message|action=send|to=channel:a",
    } as const;
    const actionB = {
      toolName: "message",
      error: "B failed",
      mutatingAction: true,
      actionFingerprint: "tool=message|action=send|to=channel:b",
    } as const;
    const state = mergeUnresolvedMutationError(
      actionA,
      mergeUnresolvedMutationError(actionB, mergeUnresolvedMutationError(actionA, undefined)),
    );

    expect(state.error).toBe("A failed again");
    expect(resolveSuccessfulToolMutation(state, actionA)?.error).toBe("B failed");
  });
});
