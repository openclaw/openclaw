import { describe, expect, it } from "vitest";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
  isInterpreterLikeAllowlistPattern,
} from "./exec-inline-eval.js";

describe("exec inline eval detection", () => {
  it.each([
    { argv: ["python3", "-c", "print('hi')"], expected: "python3 -c" },
    { argv: ["/usr/bin/node", "--eval", "console.log('hi')"], expected: "node --eval" },
    { argv: ["perl", "-E", "say 1"], expected: "perl -e" },
    { argv: ["osascript", "-e", "beep"], expected: "osascript -e" },
  ] as const)("detects interpreter eval flags for %j", ({ argv, expected }) => {
    const hit = detectInterpreterInlineEvalArgv([...argv]);
    expect(hit).not.toBeNull();
    expect(describeInterpreterInlineEval(hit!)).toBe(expected);
  });

  it("ignores normal script execution", () => {
    expect(detectInterpreterInlineEvalArgv(["python3", "script.py"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["node", "script.js"])).toBeNull();
  });

  it("matches interpreter-like allowlist patterns", () => {
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/python3")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/node")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/awk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/gawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/rg")).toBe(false);
  });
});
