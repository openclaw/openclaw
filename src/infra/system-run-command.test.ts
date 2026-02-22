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
    expect(extractShellCommandFromArgv(["/usr/bin/nice", "/bin/bash", "-lc", "echo hi"])).toBe(
      "echo hi",
    );
    expect(
      extractShellCommandFromArgv([
        "/usr/bin/timeout",
        "--signal=TERM",
        "5",
        "zsh",
        "-lc",
        "echo hi",
      ]),
    ).toBe("echo hi");
  });

  test("extractShellCommandFromArgv supports fish and pwsh wrappers", () => {
    expect(extractShellCommandFromArgv(["fish", "-c", "echo hi"])).toBe("echo hi");
    expect(extractShellCommandFromArgv(["pwsh", "-Command", "Get-Date"])).toBe("Get-Date");
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

  test("validateSystemRunCommandConsistency accepts rawCommand matching env shell wrapper argv", () => {
    const res = validateSystemRunCommandConsistency({
      argv: ["/usr/bin/env", "bash", "-lc", "echo hi"],
      rawCommand: "echo hi",
    });
    expect(res.ok).toBe(true);
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
});
