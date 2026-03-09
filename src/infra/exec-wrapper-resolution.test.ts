import { describe, expect, test } from "vitest";
import { normalizeExecutableToken } from "./exec-wrapper-resolution.js";

describe("normalizeExecutableToken", () => {
  test("strips common windows executable suffixes", () => {
    expect(normalizeExecutableToken("bun.cmd")).toBe("bun");
    expect(normalizeExecutableToken("deno.bat")).toBe("deno");
    expect(normalizeExecutableToken("pwsh.com")).toBe("pwsh");
    expect(normalizeExecutableToken("cmd.exe")).toBe("cmd");
  });

  test("normalizes path-qualified windows shims", () => {
    expect(normalizeExecutableToken("C:\\tools\\bun.cmd")).toBe("bun");
    expect(normalizeExecutableToken("/tmp/deno.exe")).toBe("deno");
  });
});
