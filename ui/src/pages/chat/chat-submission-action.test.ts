/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import {
  claimChatSubmissionAction,
  runClaimedChatSubmissionAction,
} from "./chat-submission-action.ts";

describe("claimChatSubmissionAction", () => {
  it("keeps one id while marking re-entry for the same logical action", () => {
    const action = new Event("submit");

    const first = claimChatSubmissionAction(action);
    const reentry = claimChatSubmissionAction(action);

    expect(first).toEqual({ submissionId: expect.any(String), firstUse: true });
    expect(reentry).toEqual({ submissionId: first.submissionId, firstUse: false });
  });

  it("gives independent identical actions distinct ids", () => {
    const first = claimChatSubmissionAction(new Event("submit"));
    const second = claimChatSubmissionAction(new Event("submit"));

    expect(first.submissionId).not.toBe(second.submissionId);
    expect(first.firstUse).toBe(true);
    expect(second.firstUse).toBe(true);
  });

  it("runs a re-entered action only once with its stable id", () => {
    const action = new Event("submit");
    const run = vi.fn();

    runClaimedChatSubmissionAction(action, run);
    runClaimedChatSubmissionAction(action, run);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.any(String));
  });
});
