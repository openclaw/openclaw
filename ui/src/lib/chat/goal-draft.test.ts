import { expect, it } from "vitest";
import { isChatGoalDraftMode } from "./goal-draft.ts";

it("retains existing saved manual Goal modes alongside command-origin creation", () => {
  for (const mode of [
    { action: "start" },
    { action: "start", sessionId: "saved-session" },
    {
      action: "edit",
      sessionId: "saved-session",
      goalId: "saved-goal",
      previousDraft: "ordinary chat draft",
    },
    { action: "start", fromCommand: true },
  ]) {
    expect(isChatGoalDraftMode(mode)).toBe(true);
  }
  expect(isChatGoalDraftMode({ action: "start", fromCommand: "true" })).toBe(false);
  expect(
    isChatGoalDraftMode({
      action: "edit",
      goalId: "saved-goal",
      previousDraft: "draft",
      fromCommand: true,
    }),
  ).toBe(false);
});
