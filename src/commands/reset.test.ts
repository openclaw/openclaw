// Reset command tests cover cleanup runtime behavior, workspace state, and reset prompts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  gatewayService,
  listAgentSessionDirs,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
  resetCleanupCommandMocks,
  resolveCleanupPlanForRemoval,
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

  it.each([
    {
      failure: "inspection fails",
      arrange: () => gatewayService.isLoaded.mockRejectedValue(new Error("inspection failed")),
    },
    {
      failure: "stop fails",
      arrange: () => gatewayService.stop.mockRejectedValue(new Error("stop failed")),
    },
  ])("preserves user data when gateway $failure", async ({ arrange }) => {
    arrange();

    await expect(
      resetCommand(runtime, {
        scope: "full",
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
  });

  it("stops the managed Gateway before loading the destructive cleanup plan", async () => {
    gatewayService.stop.mockImplementation(async () => {
      expect(resolveCleanupPlanForRemoval).not.toHaveBeenCalled();
    });

    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
    });

    expect(resolveCleanupPlanForRemoval).toHaveBeenCalledOnce();
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

  it("does not reopen workspace state after full state removal", async () => {
    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      removeStateRows: false,
    });
  });

  it("removes workspace rows when full state removal fails", async () => {
    removeStateAndLinkedPaths.mockResolvedValueOnce(false);

    await expect(
      resetCommand(runtime, { scope: "full", yes: true, nonInteractive: true }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: false,
      removeStateRows: true,
    });
    expect(cleanupCommandLogMessages(runtime).some((message) => message.startsWith("Next:"))).toBe(
      false,
    );
  });

  it.each([
    { scope: "config" as const, failedRemoval: 0 },
    { scope: "config+creds+sessions" as const, failedRemoval: 0 },
    { scope: "config+creds+sessions" as const, failedRemoval: 1 },
    { scope: "config+creds+sessions" as const, failedRemoval: 2 },
  ])("reports failed removal $failedRemoval for $scope", async ({ scope, failedRemoval }) => {
    for (let index = 0; index < failedRemoval; index++) {
      removePath.mockResolvedValueOnce({ ok: true });
    }
    removePath.mockResolvedValueOnce({ ok: false });

    await expect(
      resetCommand(runtime, { scope, yes: true, nonInteractive: true }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removePath).toHaveBeenCalledTimes(scope === "config" ? 1 : 3);
    expect(cleanupCommandLogMessages(runtime).some((message) => message.startsWith("Next:"))).toBe(
      false,
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("retry reset"));
  });

  it("reports incomplete full reset when workspace cleanup fails", async () => {
    removeWorkspaceDirs.mockResolvedValueOnce(["/tmp/.openclaw/workspace"]);

    await expect(
      resetCommand(runtime, { scope: "full", yes: true, nonInteractive: true }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(cleanupCommandLogMessages(runtime).some((message) => message.startsWith("Next:"))).toBe(
      false,
    );
  });

  it("reports incomplete scoped reset when session directory inspection fails", async () => {
    listAgentSessionDirs.mockRejectedValueOnce(new Error("permission denied"));

    await expect(
      resetCommand(runtime, {
        scope: "config+creds+sessions",
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(runtime.error).toHaveBeenCalledWith(
      "Failed to inspect session directories: Error: permission denied",
    );
  });
});
