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

const shellCommand = ["bash", "-lc", "echo hi"];

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
  test.each<[[string, ...string[]], boolean]>([
    [["caffeinate", "-d", "-w", "42", ...shellCommand], true],
    [["script", "-q", "/dev/null", ...shellCommand], supportsScriptPositionalCommandForTests()],
    [["script", "-E", "always", "/dev/null", ...shellCommand], false],
    [["flock", "-n", "/tmp/openclaw.lock", ...shellCommand], true],
    [["flock", "-en", "/tmp/openclaw.lock", ...shellCommand], true],
    [["flock", "-E", "1", "/tmp/openclaw.lock", ...shellCommand], true],
    [["flock", "-F", "/tmp/openclaw.lock", ...shellCommand], true],
    [["flock", "-o", "/tmp/openclaw.lock", ...shellCommand], true],
    [["flock", "--nb", "/tmp/openclaw.lock", ...shellCommand], true],
    [["flock", "--wait", "1", "/tmp/openclaw.lock", ...shellCommand], true],
    [["xcrun", ...shellCommand], process.platform === "darwin"],
    [["script", "-q", "/dev/null"], false],
    [["timeout", "--bogus", "5s", ...shellCommand], false],
    [["flock", "/tmp/openclaw.lock", "-c", "echo hi"], false],
    [["flock", "/tmp/openclaw.lock", "--", ...shellCommand], false],
    [["flock", "-un", "/tmp/openclaw.lock", ...shellCommand], false],
    [["flock", "-u", "9"], false],
    [["arch", "-e", "FOO=bar", ...shellCommand], false],
    [["arch", "-arch", "bogus", ...shellCommand], false],
    [["xcrun", "--sdk", "macosx", ...shellCommand], false],
  ])("unwraps known dispatch wrappers for %j", (argv, unwrapped) => {
    expect(unwrapKnownDispatchWrapperInvocation(argv)).toEqual({
      kind: unwrapped ? "unwrapped" : "blocked",
      wrapper: argv[0],
      ...(unwrapped ? { argv: shellCommand } : {}),
    });
  });

  test("keeps the transcript operand after the script option separator", () => {
    expect(
      unwrapKnownDispatchWrapperInvocation(
        ["script", "--", "/tmp/session.log", "bash", "-lc", "echo hi"],
        "darwin",
      ),
    ).toEqual({ kind: "unwrapped", wrapper: "script", argv: ["bash", "-lc", "echo hi"] });
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

  test.each<[[string, ...string[]], boolean]>([
    [["caffeinate", "-d", "-t", "60"], true],
    [["nice", "-n", "5"], true],
    [["nohup", "--"], true],
    [["sandbox-exec", "-p", "(allow default)"], true],
    [["sandbox-exec", "-D", "PROFILE"], true],
    [["stdbuf", "-o", "L"], true],
    [["time", "-p"], true],
    [["flock", "--timeout=2", "/tmp/openclaw.lock"], true],
    [["flock", "--close", "/tmp/openclaw.lock"], true],
    [["flock", "--no-fork", "/tmp/openclaw.lock"], true],
    [["flock", "--", "/tmp/openclaw.lock"], true],
    [["timeout", "--signal=TERM", "5s"], true],
    ...(process.platform === "darwin"
      ? ([
          [["arch", "-arm64"], true],
          [["xcrun"], false],
        ] satisfies Array<[[string, ...string[]], boolean]>)
      : []),
  ])("keeps transparent wrapper handling in sync for %j", (prefix, dispatchChainComplete) => {
    const argv = [...prefix, ...shellCommand];
    const wrapper = prefix[0];
    expect(isDispatchWrapperExecutable(wrapper)).toBe(true);
    expect(unwrapKnownDispatchWrapperInvocation(argv)).toEqual({
      kind: "unwrapped",
      wrapper,
      argv: shellCommand,
    });
    expect(resolveDispatchWrapperTrustPlan(argv)).toEqual({
      argv: shellCommand,
      wrappers: [wrapper],
      wrapperInvocations: [{ wrapper, sourceArgv: argv }],
      policyBlocked: false,
      dispatchChainComplete,
    });
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

  test.each<[[string, ...string[]], NodeJS.Platform | undefined]>([
    [["env", "FOO=bar", ...shellCommand], undefined],
    [["script", "-q", "/tmp/session.log", ...shellCommand], "darwin"],
    [["time", "-o", "/tmp/time.log", ...shellCommand], undefined],
    [["time", "--output=/tmp/time.log", ...shellCommand], undefined],
  ])(
    "blocks semantic or file-output wrapper %j despite a parseable inner shell",
    (argv, platform) => {
      const wrapper = argv[0];
      const expectedArgv = [...argv];
      expect(resolveDispatchWrapperTrustPlan(argv, undefined, platform)).toEqual({
        argv: expectedArgv,
        wrappers: [wrapper],
        wrapperInvocations: [{ wrapper, sourceArgv: expectedArgv }],
        policyBlocked: true,
        dispatchChainComplete: false,
        blockedWrapper: wrapper,
      });
    },
  );

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
  test.each<[string[], string | null, boolean, string | null]>([
    [["bash", "-lc", "echo hi"], "echo hi", true, null],
    [["busybox", "sh", "-lc", "echo hi"], "echo hi", true, null],
    [["env", "--", "pwsh", "-Command", "Get-Date"], "Get-Date", true, "Get-Date"],
    [
      ["pwsh", "-Command", "allowed.exe", ";", "unlisted.exe"],
      "allowed.exe ; unlisted.exe",
      true,
      "allowed.exe ; unlisted.exe",
    ],
    [["cmd.exe", "-c", "echo", "hi"], "echo hi", true, "echo hi"],
    [["cmd", "-k", "echo", "hi"], "echo hi", true, "echo hi"],
    [["tcsh", "-c", "echo hi"], null, false, null],
    [["nu", "--commands", "echo hi"], "echo hi", true, "echo hi"],
    [["nu", "--execute", "echo hi"], "echo hi", true, "echo hi"],
    [["nu", "--execute=echo Hi"], "echo Hi", true, "echo Hi"],
    [["nu", "--commands=echo hi"], "echo hi", true, "echo hi"],
    [["nu", "-e", "echo hi"], "echo hi", true, "echo hi"],
    [["nu", "--interactive", "-e", "echo hi"], "echo hi", true, null],
    [["nu", "--interactive", "--execute=echo hi"], "echo hi", true, null],
    [["elvish", "-c", "echo hi"], "echo hi", true, "echo hi"],
    [["pwsh", "-ec", "ZQBjAGgAbwA="], "ZQBjAGgAbwA=", true, "ZQBjAGgAbwA="],
    [["pwsh", "/NoProfile", "/ec", "ZQBjAGgAbwA="], "ZQBjAGgAbwA=", true, "ZQBjAGgAbwA="],
    [
      ["pwsh", "-WorkingDir", "/tmp/project", "/ec", "ZQBjAGgAbwA="],
      "ZQBjAGgAbwA=",
      true,
      "ZQBjAGgAbwA=",
    ],
    [
      ["pwsh", "-if", "XML", "-EncodedCommand", "ZQBjAGgAbwA="],
      "ZQBjAGgAbwA=",
      true,
      "ZQBjAGgAbwA=",
    ],
    [
      ["pwsh", "-config", "SomeConfig", "-ec", "ZQBjAGgAbwA="],
      "ZQBjAGgAbwA=",
      true,
      "ZQBjAGgAbwA=",
    ],
    [["pwsh", "-win", "hidden", "/ec", "ZQBjAGgAbwA="], "ZQBjAGgAbwA=", true, "ZQBjAGgAbwA="],
    [["pwsh", "-ea", "stop", "-Command", "Get-Date"], "Get-Date", true, "Get-Date"],
    [["pwsh", "-ep", "Bypass", "-Command", "Get-Date"], "Get-Date", true, "Get-Date"],
    [["pwsh", "-cus", "pipe-name", "-ec", "ZQBjAGgAbwA="], "ZQBjAGgAbwA=", true, "ZQBjAGgAbwA="],
    [["pwsh", "-to", "token-value", "-Command", "Get-Date"], "Get-Date", true, "Get-Date"],
    [["pwsh", "-utc", "1234", "-Command", "Get-Date"], "Get-Date", true, "Get-Date"],
    [["pwsh", "-encodeda", "YQByAGcA", "-Command", "Get-Date"], "Get-Date", true, "Get-Date"],
    [["pwsh", "-en", "ZQBjAGgAbwA="], "ZQBjAGgAbwA=", true, "ZQBjAGgAbwA="],
    [["pwsh", "-File", "script.ps1", "-ExtraArg"], "script.ps1", true, "script.ps1"],
    [
      ["pwsh", "--commandwithargs", "allowed.exe", ";", "unlisted.exe"],
      "allowed.exe ; unlisted.exe",
      true,
      "allowed.exe ; unlisted.exe",
    ],
    [
      ["pwsh", "-CommandWithArgs", "allowed.exe", ";", "unlisted.exe"],
      "allowed.exe ; unlisted.exe",
      true,
      "allowed.exe ; unlisted.exe",
    ],
    [["pwsh", "-cwa", "Write-Output", "hi"], "Write-Output hi", true, "Write-Output hi"],
    [["pwsh", "script.ps1", "-en", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"], null, false, null],
    [["bash", "script.sh"], null, false, null],
  ])("extracts inline commands for %j", (argv, expectedInline, isWrapper, command) => {
    expect(extractShellWrapperInlineCommand(argv)).toBe(expectedInline);
    expect(extractShellWrapperCommand(argv)).toEqual({ isWrapper, command });
  });

  test("prefers an explicit raw command override when provided", () => {
    expect(extractShellWrapperCommand(["bash", "-c", "echo hi"], "  run this instead  ")).toEqual({
      isWrapper: true,
      command: "run this instead",
    });
  });
});
