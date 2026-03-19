import { describe, expect, it } from "vitest";
import {
  appendCapturedOutput,
  hasFatalTestRunOutput,
  resolveTestRunExitCode,
} from "../../scripts/test-parallel-utils.mjs";

describe("scripts/test-parallel fatal output guard", () => {
  it("fails a zero exit when V8 reports an out-of-memory fatal", () => {
    const output = [
      "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory",
      "node::OOMErrorHandler(char const*, v8::OOMDetails const&)",
      "[test-parallel] done unit-fast code=0 elapsed=210.9s",
    ].join("\n");

    expect(hasFatalTestRunOutput(output)).toBe(true);
    expect(resolveTestRunExitCode({ code: 0, signal: null, output })).toBe(1);
  });

  it("keeps a clean zero exit green", () => {
    expect(
      resolveTestRunExitCode({
        code: 0,
        signal: null,
        output: "Test Files  3 passed (3)",
      }),
    ).toBe(0);
  });

  it("preserves explicit non-zero exits", () => {
    expect(resolveTestRunExitCode({ code: 2, signal: null, output: "" })).toBe(2);
  });

  it("keeps only the tail of captured output", () => {
    const output = appendCapturedOutput("", "abc", 5);
    expect(appendCapturedOutput(output, "defg", 5)).toBe("cdefg");
  });
});
