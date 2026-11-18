import { describe, expect, test } from "vitest";
import { shellEscape, shellEscapeBackslash } from "./shell-quote.js";

describe("literal POSIX shell quoting", () => {
  test.each([
    ["", "''", "''"],
    ["a'b", `'a'"'"'b'`, "'a'\\''b'"],
    ["$HOME; `echo hi`\\雪\n", "'$HOME; `echo hi`\\雪\n'", "'$HOME; `echo hi`\\雪\n'"],
  ])("preserves both established representations for %j", (input, quoted, backslashQuoted) => {
    expect(shellEscape(input)).toBe(quoted);
    expect(shellEscapeBackslash(input)).toBe(backslashQuoted);
  });
});
