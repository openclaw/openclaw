import { describe, expect, it } from "vitest";
import { sanitizeForLog, stripAnsi } from "./ansi.js";

describe("terminal ansi helpers", () => {
  it("strips ANSI and OSC8 sequences", () => {
    expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red");
    expect(stripAnsi("\u001B]8;;https://openclaw.ai\u001B\\link\u001B]8;;\u001B\\")).toBe("link");
  });

  it("sanitizes control characters for log-safe interpolation", () => {
    const input = "\u001B[31mwarn\u001B[0m\r\nnext\u0000line\u007f";
    expect(sanitizeForLog(input)).toBe("warnnextline");
  });
});
