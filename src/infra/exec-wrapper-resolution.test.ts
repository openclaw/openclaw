// Tests execution wrapper resolution for shell commands.
import { describe, expect, test } from "vitest";
import {
  extractEnvAssignmentKeysFromDispatchWrappers,
  extractShellWrapperCommand,
  hasEnvManipulationBeforeShellWrapper,
  isShellWrapperInvocation,
  normalizeExecutableToken,
  resolveShellWrapperTransportArgv,
  unwrapKnownDispatchWrapperInvocation,
  unwrapKnownShellMultiplexerInvocation,
} from "./exec-wrapper-resolution.js";

function supportsScriptPositionalCommandForTests(): boolean {
  return process.platform === "darwin" || process.platform === "freebsd";
}

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

describe("unwrapKnownDispatchWrapperInvocation", () => {
  test.each([
    {
      argv: ["caffeinate", "-d", "-w", "42", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "caffeinate", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["env", "--", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "env", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["nice", "-n", "5", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "nice", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["nohup", "--", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "nohup", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["script", "-q", "/dev/null", "bash", "-lc", "echo hi"],
      expected: supportsScriptPositionalCommandForTests()
        ? { kind: "unwrapped", wrapper: "script", argv: ["bash", "-lc", "echo hi"] }
        : { kind: "blocked", wrapper: "script" },
    },
    {
      argv: ["script", "-E", "always", "/dev/null", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "script" },
    },
    {
      argv: ["stdbuf", "-o", "L", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "stdbuf", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["time", "-p", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "time", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["flock", "-n", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["flock", "-en", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["flock", "-E", "1", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["flock", "-F", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["flock", "-o", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["flock", "--nb", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["flock", "--wait", "1", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["timeout", "--signal=TERM", "5s", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "timeout", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["sandbox-exec", "-p", "(allow default)", "bash", "-lc", "echo hi"],
      expected: {
        kind: "unwrapped",
        wrapper: "sandbox-exec",
        argv: ["bash", "-lc", "echo hi"],
      },
    },
    {
      argv: ["sandbox-exec", "-D", "PROFILE", "bash", "-lc", "echo hi"],
      expected: {
        kind: "unwrapped",
        wrapper: "sandbox-exec",
        argv: ["bash", "-lc", "echo hi"],
      },
    },
    {
      argv: ["xcrun", "bash", "-lc", "echo hi"],
      expected:
        process.platform === "darwin"
          ? { kind: "unwrapped", wrapper: "xcrun", argv: ["bash", "-lc", "echo hi"] }
          : { kind: "blocked", wrapper: "xcrun" },
    },
    {
      argv: ["script", "-q", "/dev/null"],
      expected: { kind: "blocked", wrapper: "script" },
    },
    {
      argv: ["sudo", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "sudo" },
    },
    {
      argv: ["timeout", "--bogus", "5s", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "timeout" },
    },
    {
      argv: ["flock", "/tmp/openclaw.lock", "-c", "echo hi"],
      expected: { kind: "blocked", wrapper: "flock" },
    },
    {
      argv: ["flock", "-un", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "flock" },
    },
    {
      argv: ["flock", "-u", "9"],
      expected: { kind: "blocked", wrapper: "flock" },
    },
    {
      argv: ["arch", "-e", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "arch" },
    },
    {
      argv: ["arch", "-arch", "bogus", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "arch" },
    },
    {
      argv: ["arch", "-arch", "bogus", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "arch" },
    },
    {
      argv: ["xcrun", "--sdk", "macosx", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "xcrun" },
    },
  ])("unwraps known dispatch wrappers for %j", ({ argv, expected }) => {
    expect(unwrapKnownDispatchWrapperInvocation(argv)).toEqual(expected);
  });

  test("blocks arch dispatch unwrapping outside macOS", () => {
    expect(
      unwrapKnownDispatchWrapperInvocation(["arch", "-arm64", "bash", "-lc", "echo hi"], "linux"),
    ).toEqual({
      kind: "blocked",
      wrapper: "arch",
    });
  });

  test.each(["chrt", "doas", "ionice", "setsid", "sudo", "taskset"])(
    "fails closed for blocked dispatch wrapper %s",
    (wrapper) => {
      expect(unwrapKnownDispatchWrapperInvocation([wrapper, "bash", "-lc", "echo hi"])).toEqual({
        kind: "blocked",
        wrapper,
      });
    },
  );
});

describe("hasEnvManipulationBeforeShellWrapper", () => {
  test.each([
    {
      argv: ["env", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: true,
    },
    {
      argv: ["timeout", "5s", "env", "--", "bash", "-lc", "echo hi"],
      expected: false,
    },
    {
      argv: ["timeout", "5s", "env", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: true,
    },
    {
      argv: ["sudo", "bash", "-lc", "echo hi"],
      expected: false,
    },
  ])("detects env manipulation before shell wrappers for %j", ({ argv, expected }) => {
    expect(hasEnvManipulationBeforeShellWrapper(argv)).toBe(expected);
  });
});

describe("resolveShellWrapperTransportArgv", () => {
  test.each([
    {
      argv: ["env", "cmd.exe", "/d", "/s", "/c", "echo hi"],
      expected: ["cmd.exe", "/d", "/s", "/c", "echo hi"],
    },
    {
      argv: ["env", "FOO=bar", "cmd.exe", "/d", "/s", "/c", "echo hi"],
      expected: ["cmd.exe", "/d", "/s", "/c", "echo hi"],
    },
    {
      argv: ["bash", "script.sh"],
      expected: null,
    },
  ])("resolves wrapper transport argv for %j", ({ argv, expected }) => {
    expect(resolveShellWrapperTransportArgv(argv)).toEqual(expected);
  });
});

describe("isShellWrapperInvocation", () => {
  test.each([
    {
      argv: ["bash", "script.sh"],
      expected: true,
    },
    {
      argv: ["/usr/bin/env", "SHELLOPTS=xtrace", "bash", "-lc", "echo hi"],
      expected: true,
    },
    {
      argv: ["busybox", "sh", "script.sh"],
      expected: true,
    },
    {
      argv: ["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"],
      expected: false,
    },
  ])("detects shell-wrapper executable invocations for %j", ({ argv, expected }) => {
    expect(isShellWrapperInvocation(argv)).toBe(expected);
  });
});

describe("extractEnvAssignmentKeysFromDispatchWrappers", () => {
  test.each([
    {
      argv: ["env", "FOO=bar", "BAR=baz", "bash", "-lc", "echo hi"],
      expected: ["BAR", "FOO"],
    },
    {
      argv: ["nice", "-n", "5", "env", "-u", "PATH", "TERM=xterm", "bash", "-lc", "echo hi"],
      expected: ["TERM"],
    },
    {
      argv: ["env", "--split-string", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: [],
    },
    {
      argv: ["env", "--", "bash", "-lc", "echo hi"],
      expected: [],
    },
  ])("extracts env assignment prelude keys for %j", ({ argv, expected }) => {
    expect(extractEnvAssignmentKeysFromDispatchWrappers(argv)).toEqual(expected);
  });
});

describe("extractShellWrapperCommand", () => {
  test.each([
    {
      argv: ["bash", "-lc", "echo hi"],
      expected: { isWrapper: true, command: null },
    },
    {
      argv: ["busybox", "sh", "-lc", "echo hi"],
      expected: { isWrapper: true, command: null },
    },
    {
      argv: ["env", "--", "pwsh", "-Command", "Get-Date"],
      expected: { isWrapper: true, command: "Get-Date" },
    },
    {
      argv: ["cmd.exe", "-c", "echo", "hi"],
      expected: { isWrapper: true, command: "echo hi" },
    },
    {
      argv: ["pwsh", "/NoProfile", "/ec", "ZQBjAGgAbwA="],
      expected: { isWrapper: true, command: "ZQBjAGgAbwA=" },
    },
    {
      argv: ["pwsh", "-WorkingDir", "/tmp/project", "/ec", "ZQBjAGgAbwA="],
      expected: { isWrapper: true, command: "ZQBjAGgAbwA=" },
    },
    {
      argv: ["pwsh", "-ea", "stop", "-Command", "Get-Date"],
      expected: { isWrapper: true, command: "Get-Date" },
    },
    {
      argv: ["pwsh", "-File", "script.ps1", "-ExtraArg"],
      expected: { isWrapper: true, command: "script.ps1" },
    },
    {
      argv: ["pwsh", "-CommandWithArgs", "allowed.exe", ";", "unlisted.exe"],
      expected: { isWrapper: true, command: "allowed.exe ; unlisted.exe" },
    },
    {
      argv: ["pwsh", "script.ps1", "-en", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { isWrapper: false, command: null },
    },
    {
      argv: ["bash", "script.sh"],
      expected: { isWrapper: false, command: null },
    },
  ])("extracts wrapper command for $argv", ({ argv, expected }) => {
    expect(extractShellWrapperCommand(argv)).toEqual(expected);
  });

  test("prefers an explicit raw command override when provided", () => {
    expect(extractShellWrapperCommand(["bash", "-c", "echo hi"], "  run this instead  ")).toEqual({
      isWrapper: true,
      command: "run this instead",
    });
  });
});
