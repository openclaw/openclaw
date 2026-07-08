// Code Mode Namespace Live tests cover live repro argument parsing.
import { describe, expect, it } from "vitest";
import { parseTaskLimit } from "../../scripts/repro/code-mode-namespace-live.ts";

describe("code-mode namespace live repro", () => {
  it("parses task limits as strict positive integers", () => {
    expect(parseTaskLimit(undefined, "--tasks")).toBe(3);
    expect(parseTaskLimit(" 2 ", "--tasks")).toBe(2);

    expect(() => parseTaskLimit("0", "--tasks")).toThrow("--tasks must be a positive integer");
    expect(() => parseTaskLimit("1e3", "--tasks")).toThrow("--tasks must be a positive integer");
    expect(() => parseTaskLimit("2.5", "--tasks")).toThrow("--tasks must be a positive integer");
    expect(() => parseTaskLimit("3 tasks", "--tasks")).toThrow(
      "--tasks must be a positive integer",
    );
  });

  it("reports the environment variable name for inherited task limits", () => {
    expect(() => parseTaskLimit("1e3", "OPENCLAW_CODE_MODE_LIVE_TASKS")).toThrow(
      "OPENCLAW_CODE_MODE_LIVE_TASKS must be a positive integer",
    );
  });
});
