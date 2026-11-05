import { expect, it } from "vitest";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";

it("preserves the session with the built-in context overflow recovery hint", () => {
  const text = buildContextOverflowRecoveryText();
  expect(text).toContain("fresh session or using a model with a larger context window");
  expect(text).not.toContain("reserveTokensFloor");
  expect(text).toContain("kept this conversation mapped to the current session");
  expect(text).not.toContain("reset our conversation");
});
