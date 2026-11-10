import { describe, expect, it } from "vitest";
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

  it.each([
    ["openclaw cron --help", "cron-cli", /exec cannot run `openclaw cron` commands directly/],
    [
      "openclaw --no-color cron --help",
      "cron-cli",
      /exec cannot run `openclaw cron` commands directly/,
    ],
    [
      "openclaw automations create --at '2m'",
      "automations-cli",
      /exec cannot run `openclaw automations` commands directly/,
    ],
    [
      "npx openclaw --profile dev automations create",
      "automations-cli",
      /exec cannot run `openclaw automations` commands directly/,
    ],
    ["npx openclaw message send --target 123", "message-cli", /message: \.\.\./],
  ])(
    "rejects direct CLI state mutation commands in gateway context: %s",
    async (command, expectedKind, expectedError) => {
      await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe(expectedKind);
      await expect(rejectUnsafeExecControlShellCommand(command)).rejects.toThrow(expectedError);
    },
  );

  it("permits openclaw CLI execution outside gateway context (e.g. host=node or host=sandbox)", async () => {
    const command = "openclaw cron list";
    await expect(
      detectUnsafeExecControlShellCommand(command, { host: "node" }),
    ).resolves.toBeNull();
    await expect(
      rejectUnsafeExecControlShellCommand(command, { host: "node" }),
    ).resolves.toBeUndefined();

    await expect(
      detectUnsafeExecControlShellCommand(command, { host: "sandbox" }),
    ).resolves.toBeNull();
    await expect(
      rejectUnsafeExecControlShellCommand(command, { host: "sandbox" }),
    ).resolves.toBeUndefined();
  });
});
