import { describe, expect, test } from "vitest";
import {
  basenameLower,
  isDispatchWrapperExecutable,
  isShellWrapperExecutable,
  normalizeExecutableToken,
  unwrapKnownShellMultiplexerInvocation,
} from "./exec-wrapper-resolution.js";

describe("basenameLower", () => {
  test.each([
    { token: " Bun.CMD ", expected: "bun.cmd" },
    { token: "C:\\tools\\PwSh.EXE", expected: "pwsh.exe" },
    { token: "/tmp/bash", expected: "bash" },
  ])("normalizes basenames for %j", ({ token, expected }) => {
    expect(basenameLower(token)).toBe(expected);
  });
});

describe("normalizeExecutableToken", () => {
  test.each([
    { token: "bun.cmd", expected: "bun" },
    { token: "deno.bat", expected: "deno" },
    { token: "pwsh.com", expected: "pwsh" },
    { token: "cmd.exe", expected: "cmd" },
    { token: "C:\\tools\\bun.cmd", expected: "bun" },
    { token: "/tmp/deno.exe", expected: "deno" },
    { token: " /tmp/bash ", expected: "bash" },
  ])("normalizes executable tokens for %j", ({ token, expected }) => {
    expect(normalizeExecutableToken(token)).toBe(expected);
  });
});

describe("wrapper classification", () => {
  test.each([
    { token: "sudo", dispatch: true, shell: false },
    { token: "timeout.exe", dispatch: true, shell: false },
    { token: "bash", dispatch: false, shell: true },
    { token: "pwsh.exe", dispatch: false, shell: true },
    { token: "node", dispatch: false, shell: false },
  ])("classifies wrappers for %j", ({ token, dispatch, shell }) => {
    expect(isDispatchWrapperExecutable(token)).toBe(dispatch);
    expect(isShellWrapperExecutable(token)).toBe(shell);
  });
});

describe("unwrapKnownShellMultiplexerInvocation", () => {
  test.each([
    { argv: [], expected: { kind: "not-wrapper" } },
    { argv: ["node", "-e", "1"], expected: { kind: "not-wrapper" } },
    { argv: ["busybox"], expected: { kind: "blocked", wrapper: "busybox" } },
    { argv: ["busybox", "ls"], expected: { kind: "blocked", wrapper: "busybox" } },
    {
      argv: ["busybox", "sh", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "busybox", argv: ["sh", "-lc", "echo hi"] },
    },
    {
      argv: ["toybox", "--", "pwsh.exe", "-Command", "Get-Date"],
      expected: {
        kind: "unwrapped",
        wrapper: "toybox",
        argv: ["pwsh.exe", "-Command", "Get-Date"],
      },
    },
  ])("unwraps shell multiplexers for %j", ({ argv, expected }) => {
    expect(unwrapKnownShellMultiplexerInvocation(argv)).toEqual(expected);
  });
});
