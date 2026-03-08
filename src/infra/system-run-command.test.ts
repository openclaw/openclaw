import { describe, expect, test } from "vitest";
import {
  extractShellCommandFromArgv,
  formatExecCommand,
  resolveSystemRunCommand,
  validateSystemRunCommandConsistency,
} from "./system-run-command.js";

describe("system run command helpers", () => {
  function expectRawCommandMismatch(params: { argv: string[]; rawCommand: string }) {
    const res = validateSystemRunCommandConsistency(params);
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("unreachable");
    }
    expect(res.message).toContain("rawCommand does not match command");
    expect(res.details?.code).toBe("RAW_COMMAND_MISMATCH");
  }

  test("formatExecCommand quotes args with spaces", () => {
    expect(formatExecCommand(["echo", "hi there"])).toBe('echo "hi there"');
  });

  test("formatExecCommand preserves trailing whitespace in argv tokens", () => {
    expect(formatExecCommand(["runner "])).toBe('"runner "');
  });

  test("extractShellCommandFromArgv extracts sh -lc command", () => {
    expect(extractShellCommandFromArgv(["/bin/sh", "-lc", "echo hi"])).toBe("echo hi");
  });

  test("extractShellCommandFromArgv extracts cmd.exe /c command", () => {
    expect(extractShellCommandFromArgv(["cmd.exe", "/d", "/s", "/c", "echo hi"])).toBe("echo hi");
  });

  test("extractShellCommandFromArgv unwraps /usr/bin/env shell wrappers", () => {
    expect(extractShellCommandFromArgv(["/usr/bin/env", "bash", "-lc", "echo hi"])).toBe("echo hi");
    expect(extractShellCommandFromArgv(["/usr/bin/env", "FOO=bar", "zsh", "-c", "echo hi"])).toBe(
      "echo hi",
    );
  });

  test("extractShellCommandFromArgv unwraps known dispatch wrappers before shell wrappers", () => {
    const cases = [
      ["/usr/bin/nice", "/bin/bash", "-lc", "echo hi"],
      ["/usr/bin/timeout", "--signal=TERM", "5", "zsh", "-lc", "echo hi"],
      ["/usr/bin/env", "/usr/bin/env", "/usr/bin/env", "/usr/bin/env", "/bin/sh", "-c", "echo hi"],
    ];
    for (const argv of cases) {
      expect(extractShellCommandFromArgv(argv)).toBe("echo hi");
    }
  });

  test("extractShellCommandFromArgv supports fish and pwsh wrappers", () => {
    expect(extractShellCommandFromArgv(["fish", "-c", "echo hi"])).toBe("echo hi");
    expect(extractShellCommandFromArgv(["pwsh", "-Command", "Get-Date"])).toBe("Get-Date");
    expect(extractShellCommandFromArgv(["pwsh", "-EncodedCommand", "ZQBjAGgAbwA="])).toBe(
      "ZQBjAGgAbwA=",
    );
    expect(extractShellCommandFromArgv(["powershell", "-enc", "ZQBjAGgAbwA="])).toBe(
      "ZQBjAGgAbwA=",
    );
  });

  test("extractShellCommandFromArgv unwraps busybox/toybox shell applets", () => {
    expect(extractShellCommandFromArgv(["busybox", "sh", "-c", "echo hi"])).toBe("echo hi");
    expect(extractShellCommandFromArgv(["toybox", "ash", "-lc", "echo hi"])).toBe("echo hi");
  });

  test("extractShellCommandFromArgv ignores env wrappers when no shell wrapper follows", () => {
    expect(extractShellCommandFromArgv(["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"])).toBe(
      null,
    );
    expect(extractShellCommandFromArgv(["/usr/bin/env", "FOO=bar"])).toBe(null);
  });

  test("extractShellCommandFromArgv includes trailing cmd.exe args after /c", () => {
    expect(extractShellCommandFromArgv(["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"])).toBe(
      "echo SAFE&&whoami",
    );
  });

  test("validateSystemRunCommandConsistency accepts rawCommand matching direct argv", () => {
    const res = validateSystemRunCommandConsistency({
      argv: ["echo", "hi"],
      rawCommand: "echo hi",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("unreachable");
    }
    expect(res.shellCommand).toBe(null);
    expect(res.cmdText).toBe("echo hi");
  });

  test("validateSystemRunCommandConsistency rejects mismatched rawCommand vs direct argv", () => {
    expectRawCommandMismatch({
      argv: ["uname", "-a"],
      rawCommand: "echo hi",
    });
  });

  test("validateSystemRunCommandConsistency accepts rawCommand matching sh wrapper argv", () => {
    const res = validateSystemRunCommandConsistency({
      argv: ["/bin/sh", "-lc", "echo hi"],
      rawCommand: "echo hi",
    });
    expect(res.ok).toBe(true);
  });

  test("validateSystemRunCommandConsistency rejects shell-only rawCommand for positional-argv carrier wrappers", () => {
    expectRawCommandMismatch({
      argv: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
      rawCommand: '$0 "$1"',
    });
  });

  test("validateSystemRunCommandConsistency accepts rawCommand matching env shell wrapper argv", () => {
    const res = validateSystemRunCommandConsistency({
      argv: ["/usr/bin/env", "bash", "-lc", "echo hi"],
      rawCommand: "echo hi",
    });
    expect(res.ok).toBe(true);
  });

  test("validateSystemRunCommandConsistency rejects shell-only rawCommand for env assignment prelude", () => {
    expectRawCommandMismatch({
      argv: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo hi"],
      rawCommand: "echo hi",
    });
  });

  test("validateSystemRunCommandConsistency accepts full rawCommand for env assignment prelude", () => {
    const raw = '/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc "echo hi"';
    const res = validateSystemRunCommandConsistency({
      argv: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo hi"],
      rawCommand: raw,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("unreachable");
    }
    expect(res.shellCommand).toBe("echo hi");
    expect(res.cmdText).toBe(raw);
  });

  test("validateSystemRunCommandConsistency rejects cmd.exe /c trailing-arg smuggling", () => {
    expectRawCommandMismatch({
      argv: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
      rawCommand: "echo",
    });
  });

  test("validateSystemRunCommandConsistency rejects mismatched rawCommand vs sh wrapper argv", () => {
    expectRawCommandMismatch({
      argv: ["/bin/sh", "-lc", "echo hi"],
      rawCommand: "echo bye",
    });
  });

  test("validateSystemRunCommandConsistency accepts rawCommand with basename when argv has absolute path", () => {
    // LLMs commonly send argv with absolute paths but rawCommand with short names.
    // This is the most frequent real-world mismatch: the LLM resolves the binary
    // to its absolute path in argv but uses the short name in rawCommand.
    const res = validateSystemRunCommandConsistency({
      argv: ["/bin/echo", "hello"],
      rawCommand: "echo hello",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("unreachable");
    }
    expect(res.cmdText).toBe("echo hello");
  });

  test("validateSystemRunCommandConsistency accepts rawCommand with basename for multi-segment paths", () => {
    const res = validateSystemRunCommandConsistency({
      argv: ["/usr/bin/curl", "-s", "http://example.com"],
      rawCommand: "curl -s http://example.com",
    });
    expect(res.ok).toBe(true);
  });

  test("validateSystemRunCommandConsistency accepts rawCommand with basename for Windows paths", () => {
    const res = validateSystemRunCommandConsistency({
      argv: ["C:\\Windows\\System32\\curl.exe", "-s", "http://example.com"],
      rawCommand: "curl.exe -s http://example.com",
    });
    expect(res.ok).toBe(true);
  });

  test("validateSystemRunCommandConsistency does not apply basename fallback for shell wrappers", () => {
    // Shell-wrapper argv: /bin/sh -lc "echo hi" → inferred is "echo hi" (inner command).
    // Basename fallback should NOT match 'sh -lc "echo hi"' as rawCommand — that would
    // cause unexpected double-wrapping if downstream code spawns in another shell context.
    expectRawCommandMismatch({
      argv: ["/bin/sh", "-lc", "echo hi"],
      rawCommand: 'sh -lc "echo hi"',
    });
  });

  test("validateSystemRunCommandConsistency rejects relative path basename fallback", () => {
    // Relative paths (./tool, ../bin/tool) should NOT trigger basename fallback.
    // The user should see the relative path in approval prompts to know they're
    // executing a local script, not a system binary.
    expectRawCommandMismatch({
      argv: ["./tool", "--flag"],
      rawCommand: "tool --flag",
    });
    expectRawCommandMismatch({
      argv: ["../bin/tool", "--flag"],
      rawCommand: "tool --flag",
    });
  });

  test("validateSystemRunCommandConsistency rejects genuinely different commands even with path prefix", () => {
    // Basename fallback should not weaken security — different command names still fail.
    expectRawCommandMismatch({
      argv: ["/bin/echo", "hello"],
      rawCommand: "cat hello",
    });
  });

  test("resolveSystemRunCommand requires command when rawCommand is present", () => {
    const res = resolveSystemRunCommand({ rawCommand: "echo hi" });
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("unreachable");
    }
    expect(res.message).toContain("rawCommand requires params.command");
    expect(res.details?.code).toBe("MISSING_COMMAND");
  });

  test("resolveSystemRunCommand returns normalized argv and cmdText", () => {
    const res = resolveSystemRunCommand({
      command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
      rawCommand: "echo SAFE&&whoami",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("unreachable");
    }
    expect(res.argv).toEqual(["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"]);
    expect(res.shellCommand).toBe("echo SAFE&&whoami");
    expect(res.cmdText).toBe("echo SAFE&&whoami");
  });

  test("resolveSystemRunCommand binds cmdText to full argv for shell-wrapper positional-argv carriers", () => {
    const res = resolveSystemRunCommand({
      command: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("unreachable");
    }
    expect(res.shellCommand).toBe('$0 "$1"');
    expect(res.cmdText).toBe('/bin/sh -lc "$0 \\"$1\\"" /usr/bin/touch /tmp/marker');
  });

  test("resolveSystemRunCommand binds cmdText to full argv when env prelude modifies shell wrapper", () => {
    const res = resolveSystemRunCommand({
      command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo hi"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("unreachable");
    }
    expect(res.shellCommand).toBe("echo hi");
    expect(res.cmdText).toBe('/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc "echo hi"');
  });
});
