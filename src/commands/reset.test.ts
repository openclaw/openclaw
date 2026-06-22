// Reset command tests cover cleanup runtime behavior, workspace attestations, and reset prompts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  removeWorkspaceAttestationPaths,
  resetCleanupCommandMocks,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

describe("resetCommand", () => {
  const runtime = createCleanupCommandRuntime();
  let resetCommand: typeof import("./reset.js").resetCommand;

  beforeAll(async () => {
    ({ resetCommand } = await import("./reset.js"));
  });

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
  });

  it("recommends creating a backup before state-destructive reset scopes", async () => {
    await resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(true);
  });

  it("does not recommend backup for config-only reset", async () => {
    await resetCommand(runtime, {
      scope: "config",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(false);
  });

  it("removes workspace attestations during full reset", async () => {
    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceAttestationPaths).toHaveBeenCalledWith(
      ["/tmp/.openclaw/workspace"],
      runtime,
      { dryRun: true },
    );
  });

  it("rejects non-interactive mode without --yes and includes recovery hint", async () => {
    await expect(
      resetCommand(runtime, { nonInteractive: true }),
    ).rejects.toThrow("exit 1");

    const errorCalls = (runtime.error as MockFn<(...args: unknown[]) => void>).mock.calls;
    const messages = errorCalls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("--yes"))).toBe(true);
    expect(messages.some((m) => m.includes("openclaw reset --scope"))).toBe(true);
  });

  it("rejects non-interactive mode without --scope and lists valid scopes", async () => {
    await expect(
      resetCommand(runtime, { nonInteractive: true, yes: true }),
    ).rejects.toThrow("exit 1");

    const errorCalls = (runtime.error as MockFn<(...args: unknown[]) => void>).mock.calls;
    const messages = errorCalls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("--scope"))).toBe(true);
    expect(messages.some((m) => m.includes("config+creds+sessions"))).toBe(true);
  });

  it("rejects invalid --scope value and includes recovery command", async () => {
    await expect(
      resetCommand(runtime, {
        scope: "invalid" as "config",
        nonInteractive: true,
        yes: true,
      }),
    ).rejects.toThrow("exit 1");

    const errorCalls = (runtime.error as MockFn<(...args: unknown[]) => void>).mock.calls;
    const messages = errorCalls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("Invalid --scope"))).toBe(true);
    expect(messages.some((m) => m.includes("openclaw reset --scope"))).toBe(true);
  });
});
