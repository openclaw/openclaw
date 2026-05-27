import { describe, expect, test } from "vitest";
import {
  extractShellCommandFromArgv,
  formatExecCommand,
  resolveSystemRunCommand,
  resolveSystemRunCommandRequest,
  validateSystemRunCommandConsistency,
} from "./system-run-command.js";

describe("system run command helpers", () => {
  function expectValidResult<T extends { ok: boolean }>(result: T): T & { ok: true } {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    return result as T & { ok: true };
  }

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

  test.each([
    { argv: ["/usr/bin/nice", "/bin/bash", "-lc", "echo hi"], expected: "echo hi" },
    {
      argv: ["/usr/bin/timeout", "--signal=TERM", "5", "zsh", "-lc", "echo hi"],
      expected: "echo hi",
    },
    {
      argv: [
        "/usr/bin/env",
        "/usr/bin/env",
        "/usr/bin/env",
        "/usr/bin/env",
        "/bin/sh",
        "-c",
        "echo hi",
      ],
      expected: "echo hi",
    },
    { argv: ["fish", "-c", "echo hi"], expected: "echo hi" },
    { argv: ["pwsh", "-Command", "Get-Date"], expected: "Get-Date" },
    { argv: ["pwsh", "-File", "script.ps1"], expected: "script.ps1" },
    { argv: ["powershell", "-f", "script.ps1"], expected: "script.ps1" },
    { argv: ["pwsh", "-EncodedCommand", "ZQBjAGgAbwA="], expected: "ZQBjAGgAbwA=" },
    { argv: ["powershell", "-enc", "ZQBjAGgAbwA="], expected: "ZQBjAGgAbwA=" },
    { argv: ["busybox", "sh", "-c", "echo hi"], expected: "echo hi" },
    { argv: ["toybox", "ash", "-lc", "echo hi"], expected: "echo hi" },
  ])("extractShellCommandFromArgv unwraps %j", ({ argv, expected }) => {
    expect(extractShellCommandFromArgv(argv)).toBe(expected);
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
    const res = expectValidResult(
      validateSystemRunCommandConsistency({
        argv: ["echo", "hi"],
        rawCommand: "echo hi",
      }),
    );
    expect(res.shellPayload).toBe(null);
    expect(res.commandText).toBe("echo hi");
  });

  test("validateSystemRunCommandConsistency trims rawCommand before comparison", () => {
    const res = expectValidResult(
      validateSystemRunCommandConsistency({
        argv: ["echo", "hi"],
        rawCommand: "  echo hi  ",
      }),
    );
    expect(res.commandText).toBe("echo hi");
  });

  test("validateSystemRunCommandConsistency rejects mismatched rawCommand vs direct argv", () => {
    expectRawCommandMismatch({
      argv: ["uname", "-a"],
      rawCommand: "echo hi",
    });
  });

  test("validateSystemRunCommandConsistency accepts rawCommand matching sh wrapper argv", () => {
    const res = expectValidResult(
      validateSystemRunCommandConsistency({
        argv: ["/bin/sh", "-lc", "echo hi"],
        rawCommand: "echo hi",
        allowLegacyShellText: true,
      }),
    );
    expect(res.previewText).toBe("echo hi");
  });

  test("validateSystemRunCommandConsistency rejects shell-only rawCommand for positional-argv carrier wrappers", () => {
    expectRawCommandMismatch({
      argv: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
      rawCommand: '$0 "$1"',
    });
  });

  test("validateSystemRunCommandConsistency accepts rawCommand matching env shell wrapper argv", () => {
    const res = expectValidResult(
      validateSystemRunCommandConsistency({
        argv: ["/usr/bin/env", "bash", "-lc", "echo hi"],
        rawCommand: "echo hi",
        allowLegacyShellText: true,
      }),
    );
    expect(res.previewText).toBe("echo hi");
  });

  test("validateSystemRunCommandConsistency rejects shell-only rawCommand for env assignment prelude", () => {
    expectRawCommandMismatch({
      argv: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo hi"],
      rawCommand: "echo hi",
    });
  });

  test("validateSystemRunCommandConsistency accepts full rawCommand for env assignment prelude", () => {
    const raw = '/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc "echo hi"';
    const res = expectValidResult(
      validateSystemRunCommandConsistency({
        argv: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo hi"],
        rawCommand: raw,
      }),
    );
    expect(res.shellPayload).toBe("echo hi");
    expect(res.commandText).toBe(raw);
    expect(res.previewText).toBe(null);
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

  test("resolveSystemRunCommand treats non-array command values as missing", () => {
    const res = resolveSystemRunCommand({
      command: "echo hi",
      rawCommand: "echo hi",
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("unreachable");
    }
    expect(res.details?.code).toBe("MISSING_COMMAND");
  });

  test("resolveSystemRunCommand returns an empty success payload when no command is provided", () => {
    const res = expectValidResult(resolveSystemRunCommand({}));
    expect(res.argv).toEqual([]);
    expect(res.commandText).toBe("");
    expect(res.shellPayload).toBeNull();
    expect(res.previewText).toBeNull();
  });

  test("resolveSystemRunCommand stringifies non-string argv tokens", () => {
    const res = expectValidResult(
      resolveSystemRunCommand({
        command: ["echo", 123, false, null],
      }),
    );
    expect(res.argv).toEqual(["echo", "123", "false", "null"]);
    expect(res.commandText).toBe("echo 123 false null");
  });

  test("resolveSystemRunCommandRequest trims legacy rawCommand shell payloads", () => {
    const res = expectValidResult(
      resolveSystemRunCommandRequest({
        command: ["/bin/sh", "-lc", "echo hi"],
        rawCommand: "  echo hi  ",
      }),
    );
    expect(res.previewText).toBe("echo hi");
    expect(res.commandText).toBe('/bin/sh -lc "echo hi"');
  });

  test.each([
    {
      name: "resolveSystemRunCommandRequest accepts legacy shell payloads but returns canonical command text",
      run: () =>
        resolveSystemRunCommandRequest({
          command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
          rawCommand: "echo SAFE&&whoami",
        }),
      expectedArgv: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
      expectedShellPayload: "echo SAFE&&whoami",
      expectedCommandText: "cmd.exe /d /s /c echo SAFE&&whoami",
      expectedPreviewText: "echo SAFE&&whoami",
    },
    {
      name: "resolveSystemRunCommand binds commandText to full argv for shell-wrapper positional-argv carriers",
      run: () =>
        resolveSystemRunCommand({
          command: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
        }),
      expectedShellPayload: '$0 "$1"',
      expectedCommandText: '/bin/sh -lc "$0 \\"$1\\"" /usr/bin/touch /tmp/marker',
      expectedPreviewText: null,
    },
    {
      name: "resolveSystemRunCommand binds commandText to full argv when env prelude modifies shell wrapper",
      run: () =>
        resolveSystemRunCommand({
          command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo hi"],
        }),
      expectedShellPayload: "echo hi",
      expectedCommandText: '/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc "echo hi"',
      expectedPreviewText: null,
    },
    {
      name: "resolveSystemRunCommand keeps wrapper preview separate from canonical command text",
      run: () =>
        resolveSystemRunCommand({
          command: ["./env", "sh", "-c", "jq --version"],
        }),
      expectedShellPayload: "jq --version",
      expectedCommandText: './env sh -c "jq --version"',
      expectedPreviewText: "jq --version",
    },
    {
      name: "resolveSystemRunCommand accepts canonical full argv text for wrapper approvals",
      run: () =>
        resolveSystemRunCommand({
          command: ["./env", "sh", "-c", "jq --version"],
          rawCommand: './env sh -c "jq --version"',
        }),
      expectedShellPayload: "jq --version",
      expectedCommandText: './env sh -c "jq --version"',
      expectedPreviewText: "jq --version",
    },
  ])(
    "$name",
    ({ run, expectedArgv, expectedShellPayload, expectedCommandText, expectedPreviewText }) => {
      const res = expectValidResult(run());
      if (expectedArgv) {
        expect(res.argv).toEqual(expectedArgv);
      }
      expect(res.shellPayload).toBe(expectedShellPayload);
      expect(res.commandText).toBe(expectedCommandText);
      expect(res.previewText).toBe(expectedPreviewText);
    },
  );

  test("resolveSystemRunCommand rejects legacy shell payload text in strict mode", () => {
    const res = resolveSystemRunCommand({
      command: ["/bin/sh", "-lc", "echo hi"],
      rawCommand: "echo hi",
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("unreachable");
    }
    expect(res.message).toContain("rawCommand does not match command");
  });
});
