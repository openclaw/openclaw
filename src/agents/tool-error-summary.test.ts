import { describe, expect, it } from "vitest";
import { isExecLikeToolName } from "./tool-error-summary.js";

describe("isExecLikeToolName", () => {
  it.each(["exec", "bash", "exec_command"])("classifies %s as exec-like", (toolName) => {
    expect(isExecLikeToolName(toolName)).toBe(true);
  });

  it("does not classify unrelated tools as exec-like", () => {
    expect(isExecLikeToolName("browser")).toBe(false);
  });
});
