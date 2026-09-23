// Tests execution wrapper resolution for shell commands.
import { describe, expect, test } from "vitest";
import { unwrapEnvInvocation } from "./command-carriers.js";
import {
  isDispatchWrapperExecutable,
  resolveDispatchWrapperTrustPlan,
} from "./dispatch-wrapper-resolution.js";
import {
  extractEnvAssignmentKeysFromDispatchWrappers,
  extractShellWrapperCommand,
  hasEnvManipulationBeforeShellWrapper,
  isShellWrapperExecutable,
  isShellWrapperInvocation,
  normalizeExecutableToken,
  resolveShellWrapperTransportArgv,
  unwrapKnownDispatchWrapperInvocation,
  unwrapKnownShellMultiplexerInvocation,
} from "./exec-wrapper-resolution.js";
import { extractShellWrapperInlineCommand } from "./shell-wrapper-resolution.js";

function supportsScriptPositionalCommandForTests(): boolean {
  return process.platform === "darwin" || process.platform === "freebsd";
}

function expectTransparentDispatchWrapperCase(params: {
  argv: string[];
  wrapper: string;
  effectiveArgv: string[];
  dispatchChainComplete: boolean;
}) {
  expect(isDispatchWrapperExecutable(params.wrapper)).toBe(true);
  expect(unwrapKnownDispatchWrapperInvocation(params.argv)).toEqual({
    kind: "unwrapped",
    wrapper: params.wrapper,
    argv: params.effectiveArgv,
  });
  expect(resolveDispatchWrapperTrustPlan(params.argv)).toEqual({
    argv: params.effectiveArgv,
    wrappers: [params.wrapper],
    wrapperInvocations: [{ wrapper: params.wrapper, sourceArgv: params.argv }],
    policyBlocked: false,
    dispatchChainComplete: params.dispatchChainComplete,
  });
}

describe("normalizeExecutableToken", () => {
  test.each([
    ["bun.cmd", "bun"],
    ["deno.bat", "deno"],
    ["pwsh.com", "pwsh"],
    ["cmd.exe", "cmd"],
    ["C:\\tools\\bun.cmd", "bun"],
    ["/tmp/deno.exe", "deno"],
    [" /tmp/bash ", "bash"],
  ])("normalizes executable tokens for %j", (token, expected) => {
    expect(normalizeExecutableToken(token)).toBe(expected);
  });
});

describe("wrapper classification", () => {
  test.each([
    ["sudo", true, false],
    ["caffeinate", true, false],
    ["sandbox-exec", true, false],
    ["script", true, false],
    ["flock", true, false],
    ["time", true, false],
    ["timeout.exe", true, false],
    ["bash", false, true],
    ["csh", false, true],
    ["elvish", false, true],
    ["mksh", false, true],
    ["nu", false, true],
    ["nu.exe", false, true],
    ["osh", false, true],
    ["pwsh.exe", false, true],
    ["tcsh", false, true],
    ["xonsh", false, true],
    ["yash", false, true],
    ["node", false, false],
  ])("classifies wrappers for %j", (token, dispatch, shell) => {
    expect(isDispatchWrapperExecutable(token)).toBe(dispatch);
    expect(isShellWrapperExecutable(token)).toBe(shell);
  });
});

describe("unwrapKnownShellMultiplexerInvocation", () => {
  test.each([
    [[], { kind: "not-wrapper" }],
    [["node", "-e", "1"], { kind: "not-wrapper" }],
    [["busybox"], { kind: "blocked", wrapper: "busybox" }],
    [["busybox", "ls"], { kind: "blocked", wrapper: "busybox" }],
    [
      ["busybox", "sh", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "busybox", argv: ["sh", "-lc", "echo hi"] },
    ],
    [
      ["busybox", "tcsh", "-c", "echo hi"],
      { kind: "unwrapped", wrapper: "busybox", argv: ["tcsh", "-c", "echo hi"] },
    ],
    [
      ["toybox", "--", "pwsh.exe", "-Command", "Get-Date"],
      {
        kind: "unwrapped",
        wrapper: "toybox",
        argv: ["pwsh.exe", "-Command", "Get-Date"],
      },
    ],
  ])("unwraps shell multiplexers for %j", (argv, expected) => {
    expect(unwrapKnownShellMultiplexerInvocation(argv)).toEqual(expected);
  });
});

describe("unwrapEnvInvocation", () => {
  test.each([
    [
      ["env", "FOO=bar", "bash", "-lc", "echo hi"],
      ["bash", "-lc", "echo hi"],
    ],
    [
      ["env", "-i", "--unset", "PATH", "--", "sh", "-lc", "echo hi"],
      ["sh", "-lc", "echo hi"],
    ],
    [
      ["env", "--chdir=/tmp", "pwsh", "-Command", "Get-Date"],
      ["pwsh", "-Command", "Get-Date"],
    ],
    [
      ["env", "-P", "/usr/bin", "python3", "-c", "print(1)"],
      ["python3", "-c", "print(1)"],
    ],
    [
      ["env", "-S", "python3 -c", "print(1)"],
      ["python3", "-c", "print(1)"],
    ],
    [
      ["env", "--split-string=python3 -c", "print(1)"],
      ["python3", "-c", "print(1)"],
    ],
    [
      ["env", "-Spython3 -c", "print(1)"],
      ["python3", "-c", "print(1)"],
    ],
    [
      ["env", "-", "bash", "-lc", "echo hi"],
      ["bash", "-lc", "echo hi"],
    ],
    [["env", "--bogus", "bash", "-lc", "echo hi"], null],
    [["env", "--unset"], null],
  ])("unwraps env invocations for %j", (argv, expected) => {
    expect(unwrapEnvInvocation(argv)).toEqual(expected);
  });
});

describe("unwrapKnownDispatchWrapperInvocation", () => {
  test.each([
    [
      ["caffeinate", "-d", "-w", "42", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "caffeinate", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["env", "--", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "env", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["nice", "-n", "5", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "nice", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["nohup", "--", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "nohup", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["script", "-q", "/dev/null", "bash", "-lc", "echo hi"],
      supportsScriptPositionalCommandForTests()
        ? { kind: "unwrapped", wrapper: "script", argv: ["bash", "-lc", "echo hi"] }
        : { kind: "blocked", wrapper: "script" },
    ],
    [
      ["script", "-E", "always", "/dev/null", "bash", "-lc", "echo hi"],
      { kind: "blocked", wrapper: "script" },
    ],
    [
      ["stdbuf", "-o", "L", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "stdbuf", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["time", "-p", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "time", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["flock", "-n", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["flock", "-en", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["flock", "-E", "1", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["flock", "-F", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["flock", "-o", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["flock", "--nb", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["flock", "--wait", "1", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "flock", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["timeout", "--signal=TERM", "5s", "bash", "-lc", "echo hi"],
      { kind: "unwrapped", wrapper: "timeout", argv: ["bash", "-lc", "echo hi"] },
    ],
    [
      ["sandbox-exec", "-p", "(allow default)", "bash", "-lc", "echo hi"],
      {
        kind: "unwrapped",
        wrapper: "sandbox-exec",
        argv: ["bash", "-lc", "echo hi"],
      },
    ],
    [
      ["sandbox-exec", "-D", "PROFILE", "bash", "-lc", "echo hi"],
      {
        kind: "unwrapped",
        wrapper: "sandbox-exec",
        argv: ["bash", "-lc", "echo hi"],
      },
    ],
    [
      ["xcrun", "bash", "-lc", "echo hi"],
      process.platform === "darwin"
        ? { kind: "unwrapped", wrapper: "xcrun", argv: ["bash", "-lc", "echo hi"] }
        : { kind: "blocked", wrapper: "xcrun" },
    ],
    [["script", "-q", "/dev/null"], { kind: "blocked", wrapper: "script" }],
    [["sudo", "bash", "-lc", "echo hi"], { kind: "blocked", wrapper: "sudo" }],
    [
      ["timeout", "--bogus", "5s", "bash", "-lc", "echo hi"],
      { kind: "blocked", wrapper: "timeout" },
    ],
    [["flock", "/tmp/openclaw.lock", "-c", "echo hi"], { kind: "blocked", wrapper: "flock" }],
    [
      ["flock", "/tmp/openclaw.lock", "--", "bash", "-lc", "echo hi"],
      { kind: "blocked", wrapper: "flock" },
    ],
    [
      ["flock", "-un", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      { kind: "blocked", wrapper: "flock" },
    ],
    [["flock", "-u", "9"], { kind: "blocked", wrapper: "flock" }],
    [["arch", "-e", "FOO=bar", "bash", "-lc", "echo hi"], { kind: "blocked", wrapper: "arch" }],
    [["arch", "-arch", "bogus", "bash", "-lc", "echo hi"], { kind: "blocked", wrapper: "arch" }],
    [["xcrun", "--sdk", "macosx", "bash", "-lc", "echo hi"], { kind: "blocked", wrapper: "xcrun" }],
  ])("unwraps known dispatch wrappers for %j", (argv, expected) => {
    expect(unwrapKnownDispatchWrapperInvocation(argv)).toEqual(expected);
  });

  test("keeps the transcript operand after the script option separator", () => {
    expect(
      unwrapKnownDispatchWrapperInvocation(
        ["script", "--", "/tmp/session.log", "bash", "-lc", "echo hi"],
        "darwin",
      ),
    ).toEqual({ kind: "unwrapped", wrapper: "script", argv: ["bash", "-lc", "echo hi"] });
  });

  test("blocks arch dispatch unwrapping outside macOS", () => {
    expect(
      unwrapKnownDispatchWrapperInvocation(["arch", "-arm64", "bash", "-lc", "echo hi"], "linux"),
    ).toEqual({
      kind: "blocked",
      wrapper: "arch",
    });
  });

  test.each([
    "catchsegv",
    "chrt",
    "doas",
    "ionice",
    "linux32",
    "linux64",
    "numactl",
    "proxychains",
    "proxychains4",
    "setarch",
    "setsid",
    "sudo",
    "taskset",
    "torify",
    "unbuffer",
  ])("fails closed for blocked dispatch wrapper %s", (wrapper) => {
    expect(unwrapKnownDispatchWrapperInvocation([wrapper, "bash", "-lc", "echo hi"])).toEqual({
      kind: "blocked",
      wrapper,
    });
  });
});

describe("resolveDispatchWrapperTrustPlan", () => {
  test("allows non-semantic env passthrough", () => {
    expect(resolveDispatchWrapperTrustPlan(["env", "--", "bash", "-lc", "echo hi"])).toEqual({
      argv: ["bash", "-lc", "echo hi"],
      wrappers: ["env"],
      wrapperInvocations: [{ wrapper: "env", sourceArgv: ["env", "--", "bash", "-lc", "echo hi"] }],
      policyBlocked: false,
      dispatchChainComplete: true,
    });
  });

  test.each([
    ["npm", "install"],
    ["pnpm", "install"],
    ["pnpm", "run", "build"],
  ])(
    "does not classify ordinary package-manager subcommands as dispatch wrappers: %s %s",
    (executable, ...args) => {
      const argv = [executable, ...args];
      expect(unwrapKnownDispatchWrapperInvocation(argv)).toEqual({ kind: "not-wrapper" });
      expect(resolveDispatchWrapperTrustPlan(argv)).toEqual({
        argv,
        wrappers: [],
        wrapperInvocations: [],
        policyBlocked: false,
        dispatchChainComplete: true,
      });
    },
  );

  test.each([
    {
      argv: ["caffeinate", "-d", "-t", "60", "bash", "-lc", "echo hi"],
      wrapper: "caffeinate",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["nice", "-n", "5", "bash", "-lc", "echo hi"],
      wrapper: "nice",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["nohup", "--", "bash", "-lc", "echo hi"],
      wrapper: "nohup",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["sandbox-exec", "-p", "(allow default)", "bash", "-lc", "echo hi"],
      wrapper: "sandbox-exec",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["sandbox-exec", "-D", "PROFILE", "bash", "-lc", "echo hi"],
      wrapper: "sandbox-exec",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["stdbuf", "-o", "L", "bash", "-lc", "echo hi"],
      wrapper: "stdbuf",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["time", "-p", "bash", "-lc", "echo hi"],
      wrapper: "time",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["flock", "--timeout=2", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      wrapper: "flock",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["flock", "--close", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      wrapper: "flock",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["flock", "--no-fork", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      wrapper: "flock",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["flock", "--", "/tmp/openclaw.lock", "bash", "-lc", "echo hi"],
      wrapper: "flock",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    {
      argv: ["timeout", "--signal=TERM", "5s", "bash", "-lc", "echo hi"],
      wrapper: "timeout",
      effectiveArgv: ["bash", "-lc", "echo hi"],
      dispatchChainComplete: true,
    },
    ...(process.platform === "darwin"
      ? [
          {
            argv: ["arch", "-arm64", "bash", "-lc", "echo hi"],
            wrapper: "arch",
            effectiveArgv: ["bash", "-lc", "echo hi"],
            dispatchChainComplete: true,
          },
          {
            argv: ["xcrun", "bash", "-lc", "echo hi"],
            wrapper: "xcrun",
            effectiveArgv: ["bash", "-lc", "echo hi"],
            dispatchChainComplete: false,
          },
        ]
      : []),
  ])("keeps transparent wrapper handling in sync for %s", (fixture) => {
    expectTransparentDispatchWrapperCase(fixture);
  });

  test("unwraps transparent wrapper chains", () => {
    expect(
      resolveDispatchWrapperTrustPlan(["nohup", "nice", "-n", "5", "bash", "-lc", "echo hi"]),
    ).toEqual({
      argv: ["bash", "-lc", "echo hi"],
      wrappers: ["nohup", "nice"],
      wrapperInvocations: [
        { wrapper: "nohup", sourceArgv: ["nohup", "nice", "-n", "5", "bash", "-lc", "echo hi"] },
        { wrapper: "nice", sourceArgv: ["nice", "-n", "5", "bash", "-lc", "echo hi"] },
      ],
      policyBlocked: false,
      dispatchChainComplete: true,
    });
  });

  test("blocks arch trust unwrapping outside macOS", () => {
    expect(
      resolveDispatchWrapperTrustPlan(
        ["arch", "-arm64", "bash", "-lc", "echo hi"],
        undefined,
        "linux",
      ),
    ).toEqual({
      argv: ["arch", "-arm64", "bash", "-lc", "echo hi"],
      wrappers: [],
      wrapperInvocations: [],
      policyBlocked: true,
      dispatchChainComplete: false,
      blockedWrapper: "arch",
    });
  });

  test("blocks semantic env usage even when it reaches a shell wrapper", () => {
    expect(resolveDispatchWrapperTrustPlan(["env", "FOO=bar", "bash", "-lc", "echo hi"])).toEqual({
      argv: ["env", "FOO=bar", "bash", "-lc", "echo hi"],
      wrappers: ["env"],
      wrapperInvocations: [
        { wrapper: "env", sourceArgv: ["env", "FOO=bar", "bash", "-lc", "echo hi"] },
      ],
      policyBlocked: true,
      dispatchChainComplete: false,
      blockedWrapper: "env",
    });
  });

  test("blocks script transcript wrappers even when the inner command is parseable", () => {
    expect(
      resolveDispatchWrapperTrustPlan(
        ["script", "-q", "/tmp/session.log", "bash", "-lc", "echo hi"],
        undefined,
        "darwin",
      ),
    ).toEqual({
      argv: ["script", "-q", "/tmp/session.log", "bash", "-lc", "echo hi"],
      wrappers: ["script"],
      wrapperInvocations: [
        {
          wrapper: "script",
          sourceArgv: ["script", "-q", "/tmp/session.log", "bash", "-lc", "echo hi"],
        },
      ],
      policyBlocked: true,
      dispatchChainComplete: false,
      blockedWrapper: "script",
    });
  });

  test.each([
    ["short output option", ["time", "-o", "/tmp/time.log", "bash", "-lc", "echo hi"]],
    ["long output option", ["time", "--output=/tmp/time.log", "bash", "-lc", "echo hi"]],
  ])("blocks GNU time file-output wrappers for %s", (_name, argv) => {
    expect(resolveDispatchWrapperTrustPlan(argv)).toEqual({
      argv,
      wrappers: ["time"],
      wrapperInvocations: [{ wrapper: "time", sourceArgv: argv }],
      policyBlocked: true,
      dispatchChainComplete: false,
      blockedWrapper: "time",
    });
  });

  test("blocks wrapper overflow beyond the configured depth", () => {
    expect(
      resolveDispatchWrapperTrustPlan(["nohup", "timeout", "5s", "bash", "-lc", "echo hi"], 1),
    ).toEqual({
      argv: ["timeout", "5s", "bash", "-lc", "echo hi"],
      wrappers: ["nohup"],
      wrapperInvocations: [
        { wrapper: "nohup", sourceArgv: ["nohup", "timeout", "5s", "bash", "-lc", "echo hi"] },
      ],
      policyBlocked: true,
      dispatchChainComplete: false,
      blockedWrapper: "timeout",
    });
  });
});

describe("hasEnvManipulationBeforeShellWrapper", () => {
  test.each([
    [["env", "FOO=bar", "bash", "-lc", "echo hi"], true],
    [["timeout", "5s", "env", "--", "bash", "-lc", "echo hi"], false],
    [["timeout", "5s", "env", "FOO=bar", "bash", "-lc", "echo hi"], true],
    [["sudo", "bash", "-lc", "echo hi"], false],
  ])("detects env manipulation before shell wrappers for %j", (argv, expected) => {
    expect(hasEnvManipulationBeforeShellWrapper(argv)).toBe(expected);
  });
});

describe("resolveShellWrapperTransportArgv", () => {
  test.each([
    [
      ["env", "cmd.exe", "/d", "/s", "/c", "echo hi"],
      ["cmd.exe", "/d", "/s", "/c", "echo hi"],
    ],
    [
      ["env", "FOO=bar", "cmd.exe", "/d", "/s", "/c", "echo hi"],
      ["cmd.exe", "/d", "/s", "/c", "echo hi"],
    ],
    [["bash", "script.sh"], null],
  ])("resolves wrapper transport argv for %j", (argv, expected) => {
    expect(resolveShellWrapperTransportArgv(argv)).toEqual(expected);
  });
});

describe("isShellWrapperInvocation", () => {
  test.each([
    [["bash", "script.sh"], true],
    [["/usr/bin/env", "SHELLOPTS=xtrace", "bash", "-lc", "echo hi"], true],
    [["busybox", "sh", "script.sh"], true],
    [["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"], false],
  ])("detects shell-wrapper executable invocations for %j", (argv, expected) => {
    expect(isShellWrapperInvocation(argv)).toBe(expected);
  });
});

describe("extractEnvAssignmentKeysFromDispatchWrappers", () => {
  test.each([
    [
      ["env", "FOO=bar", "BAR=baz", "bash", "-lc", "echo hi"],
      ["BAR", "FOO"],
    ],
    [["nice", "-n", "5", "env", "-u", "PATH", "TERM=xterm", "bash", "-lc", "echo hi"], ["TERM"]],
    [["env", "--split-string", "FOO=bar", "bash", "-lc", "echo hi"], []],
    [["env", "--", "bash", "-lc", "echo hi"], []],
  ])("extracts env assignment prelude keys for %j", (argv, expected) => {
    expect(extractEnvAssignmentKeysFromDispatchWrappers(argv)).toEqual(expected);
  });
});

describe("extractShellWrapperCommand", () => {
  test.each([
    [["bash", "-lc", "echo hi"], "echo hi", { isWrapper: true, command: null }],
    [["busybox", "sh", "-lc", "echo hi"], "echo hi", { isWrapper: true, command: null }],
    [
      ["env", "--", "pwsh", "-Command", "Get-Date"],
      "Get-Date",
      { isWrapper: true, command: "Get-Date" },
    ],
    [
      ["pwsh", "-Command", "allowed.exe", ";", "unlisted.exe"],
      "allowed.exe ; unlisted.exe",
      { isWrapper: true, command: "allowed.exe ; unlisted.exe" },
    ],
    [["cmd.exe", "-c", "echo", "hi"], "echo hi", { isWrapper: true, command: "echo hi" }],
    [["cmd", "-k", "echo", "hi"], "echo hi", { isWrapper: true, command: "echo hi" }],
    [["tcsh", "-c", "echo hi"], null, { isWrapper: false, command: null }],
    [["nu", "--commands", "echo hi"], "echo hi", { isWrapper: true, command: "echo hi" }],
    [["nu", "--execute", "echo hi"], "echo hi", { isWrapper: true, command: "echo hi" }],
    [["nu", "--execute=echo Hi"], "echo Hi", { isWrapper: true, command: "echo Hi" }],
    [["nu", "--commands=echo hi"], "echo hi", { isWrapper: true, command: "echo hi" }],
    [["nu", "-e", "echo hi"], "echo hi", { isWrapper: true, command: "echo hi" }],
    [["nu", "--interactive", "-e", "echo hi"], "echo hi", { isWrapper: true, command: null }],
    [["nu", "--interactive", "--execute=echo hi"], "echo hi", { isWrapper: true, command: null }],
    [["elvish", "-c", "echo hi"], "echo hi", { isWrapper: true, command: "echo hi" }],
    [["pwsh", "-ec", "ZQBjAGgAbwA="], "ZQBjAGgAbwA=", { isWrapper: true, command: "ZQBjAGgAbwA=" }],
    [
      ["pwsh", "/NoProfile", "/ec", "ZQBjAGgAbwA="],
      "ZQBjAGgAbwA=",
      { isWrapper: true, command: "ZQBjAGgAbwA=" },
    ],
    [
      ["pwsh", "-WorkingDir", "/tmp/project", "/ec", "ZQBjAGgAbwA="],
      "ZQBjAGgAbwA=",
      { isWrapper: true, command: "ZQBjAGgAbwA=" },
    ],
    [
      ["pwsh", "-if", "XML", "-EncodedCommand", "ZQBjAGgAbwA="],
      "ZQBjAGgAbwA=",
      { isWrapper: true, command: "ZQBjAGgAbwA=" },
    ],
    [
      ["pwsh", "-config", "SomeConfig", "-ec", "ZQBjAGgAbwA="],
      "ZQBjAGgAbwA=",
      { isWrapper: true, command: "ZQBjAGgAbwA=" },
    ],
    [
      ["pwsh", "-win", "hidden", "/ec", "ZQBjAGgAbwA="],
      "ZQBjAGgAbwA=",
      { isWrapper: true, command: "ZQBjAGgAbwA=" },
    ],
    [
      ["pwsh", "-ea", "stop", "-Command", "Get-Date"],
      "Get-Date",
      { isWrapper: true, command: "Get-Date" },
    ],
    [
      ["pwsh", "-ep", "Bypass", "-Command", "Get-Date"],
      "Get-Date",
      { isWrapper: true, command: "Get-Date" },
    ],
    [
      ["pwsh", "-cus", "pipe-name", "-ec", "ZQBjAGgAbwA="],
      "ZQBjAGgAbwA=",
      { isWrapper: true, command: "ZQBjAGgAbwA=" },
    ],
    [
      ["pwsh", "-to", "token-value", "-Command", "Get-Date"],
      "Get-Date",
      { isWrapper: true, command: "Get-Date" },
    ],
    [
      ["pwsh", "-utc", "1234", "-Command", "Get-Date"],
      "Get-Date",
      { isWrapper: true, command: "Get-Date" },
    ],
    [
      ["pwsh", "-encodeda", "YQByAGcA", "-Command", "Get-Date"],
      "Get-Date",
      { isWrapper: true, command: "Get-Date" },
    ],
    [["pwsh", "-en", "ZQBjAGgAbwA="], "ZQBjAGgAbwA=", { isWrapper: true, command: "ZQBjAGgAbwA=" }],
    [
      ["pwsh", "-File", "script.ps1", "-ExtraArg"],
      "script.ps1",
      { isWrapper: true, command: "script.ps1" },
    ],
    [
      ["pwsh", "--commandwithargs", "allowed.exe", ";", "unlisted.exe"],
      "allowed.exe ; unlisted.exe",
      { isWrapper: true, command: "allowed.exe ; unlisted.exe" },
    ],
    [
      ["pwsh", "-CommandWithArgs", "allowed.exe", ";", "unlisted.exe"],
      "allowed.exe ; unlisted.exe",
      { isWrapper: true, command: "allowed.exe ; unlisted.exe" },
    ],
    [
      ["pwsh", "-cwa", "Write-Output", "hi"],
      "Write-Output hi",
      { isWrapper: true, command: "Write-Output hi" },
    ],
    [
      ["pwsh", "script.ps1", "-en", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      null,
      { isWrapper: false, command: null },
    ],
    [["bash", "script.sh"], null, { isWrapper: false, command: null }],
  ])("extracts inline commands for %j", (argv, expectedInline, expectedCommand) => {
    expect(extractShellWrapperInlineCommand(argv)).toBe(expectedInline);
    expect(extractShellWrapperCommand(argv)).toEqual(expectedCommand);
  });

  test("prefers an explicit raw command override when provided", () => {
    expect(extractShellWrapperCommand(["bash", "-c", "echo hi"], "  run this instead  ")).toEqual({
      isWrapper: true,
      command: "run this instead",
    });
  });
});
