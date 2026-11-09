import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  detectUnsafeExecControlShellCommand,
  rejectUnsafeExecControlShellCommand,
} from "./exec-control-command-guard.js";

function nestedCommandSubstitution(inner: string, depth: number): string {
  return "$( ".repeat(depth) + inner + " )".repeat(depth);
}

describe("exec control command guard", () => {
  it("rejects a control command below deeply nested command substitutions", async () => {
    const command = nestedCommandSubstitution("/approve abc123 allow-once", 5_000);

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
    await expect(rejectUnsafeExecControlShellCommand(command)).rejects.toThrow(
      /exec cannot run \/approve commands/,
    );
  });

  it("rejects commands that exceed the explanation work limit", async () => {
    const command = nestedCommandSubstitution("echo hi", 11_000);

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("incomplete-analysis");
    await expect(rejectUnsafeExecControlShellCommand(command)).rejects.toThrow(
      /exceeds the command explanation work limit/,
    );
  });

  it("rejects control bytes that hide later exec control commands", async () => {
    const command = "echo hi\v# ; /approve abc123 allow-once";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe(
      "unsupported-control-character",
    );
    await expect(rejectUnsafeExecControlShellCommand(command)).rejects.toThrow(
      /unsupported control characters/,
    );
    await expect(detectUnsafeExecControlShellCommand("\vecho hi")).resolves.toBe(
      "unsupported-control-character",
    );
  });

  it("rejects a partial POSIX parse that can execute an earlier command", async () => {
    const command = 'echo hi; openclaw channels login\n"';

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("parser-failure");
    await expect(rejectUnsafeExecControlShellCommand(command)).rejects.toThrow(
      /command parser is unavailable or failed/,
    );
  });

  it("keeps PowerShell CRLF commands eligible for control-command inspection", async () => {
    const ordinary = "Write-Output 1\r\nWrite-Output 2";
    const protectedCommand = "Write-Output 1\r\n/approve abc123 allow-once";

    await expect(
      detectUnsafeExecControlShellCommand(ordinary, { platform: "win32" }),
    ).resolves.toBe(null);
    await expect(
      detectUnsafeExecControlShellCommand(protectedCommand, { platform: "win32" }),
    ).resolves.toBe("approve");
    await expect(detectUnsafeExecControlShellCommand(ordinary)).resolves.toBe(
      "unsupported-control-character",
    );
    for (const command of [
      "openclaw channels`\r\nlogin",
      "/approve abc123`\r\nallow-once",
      "openclaw channels`\nlogin",
      'cmd /d /s /c "openclaw channels^\r\nlogin"',
    ]) {
      await expect(
        detectUnsafeExecControlShellCommand(command, { platform: "win32" }),
      ).resolves.toBe("unsupported-control-character");
    }
  });

  it("rejects control bytes decoded from shell wrapper payloads", async () => {
    const command = String.raw`bash -c $'echo hi\v# ; /approve abc123 allow-once'`;

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe(
      "unsupported-control-character",
    );
  });

  it("rejects shell wrappers beyond the explanation depth limit", async () => {
    let command = String.raw`bash -c $'echo safe\v#; /approve abc123 allow-once'`;
    for (let depth = 0; depth < 2; depth += 1) {
      command = `bash -c '${command.replaceAll("'", `'\\''`)}'`;
    }

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("incomplete-analysis");
  });

  it("rejects oversized commands before control-byte inspection is skipped", async () => {
    const command = `echo${" ".repeat(128 * 1024)}\v#; /approve abc123 allow-once`;

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe(
      "unsupported-control-character",
    );
    await expect(
      detectUnsafeExecControlShellCommand(
        `echo${" ".repeat(128 * 1024)}; /approve abc123 allow-once`,
      ),
    ).resolves.toBe("incomplete-analysis");
  });

  it("keeps live-state denial for commands padded with safe whitespace", async () => {
    await withTempDir("openclaw-exec-control-", async (root) => {
      const stateDir = path.join(root, "state");
      const database = path.join(stateDir, "state", "openclaw.sqlite");
      const command = `${" ".repeat(128 * 1024)}echo ok; sqlite3 ${JSON.stringify(database)} 'select 42'`;

      await expect(
        detectUnsafeExecControlShellCommand(command, { stateDir, workdir: root }),
      ).resolves.toBe("live-state-sqlite");
    });
  });
});
