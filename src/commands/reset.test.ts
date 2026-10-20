import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  gatewayService,
  removeAgentSessions,
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
  const run = (scope: Parameters<typeof resetCommand>[1]["scope"] = "full", dryRun = false) =>
    resetCommand(runtime, { scope, yes: true, nonInteractive: true, dryRun });
  const expectIncomplete = async (scope?: Parameters<typeof resetCommand>[1]["scope"]) => {
    await expect(run(scope)).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(cleanupCommandLogMessages(runtime).some((message) => message.startsWith("Next:"))).toBe(
      false,
    );
  };

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

    await expect(run()).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
  });

  it("stops the managed Gateway before loading the destructive cleanup plan", async () => {
    gatewayService.stop.mockImplementation(async () => {
      expect(resolveCleanupPlanForRemoval).not.toHaveBeenCalled();
    });

    await run();

    expect(resolveCleanupPlanForRemoval).toHaveBeenCalledOnce();
  });

  it.each([
    ["config+creds+sessions", true],
    ["config", false],
  ] as const)("recommends backup for %s: %s", async (scope, expected) => {
    await run(scope, true);
    const logs = cleanupCommandLogMessages(runtime);
    expect(logs.some((message) => message.includes("openclaw backup create"))).toBe(expected);
  });

  it("removes workspace rows when full state removal fails", async () => {
    removeStateAndLinkedPaths.mockResolvedValueOnce(false);

    await expectIncomplete();

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: false,
      removeStateRows: true,
    });
  });

  it.each([
    { scope: "config" as const, failedRemoval: 0 },
    { scope: "config+creds+sessions" as const, failedRemoval: 0 },
    { scope: "config+creds+sessions" as const, failedRemoval: 1 },
  ])("reports failed removal $failedRemoval for $scope", async ({ scope, failedRemoval }) => {
    for (let index = 0; index < failedRemoval; index++) {
      removePath.mockResolvedValueOnce({ ok: true });
    }
    removePath.mockResolvedValueOnce({ ok: false });

    await expectIncomplete(scope);

    expect(removePath).toHaveBeenCalledTimes(scope === "config" ? 1 : 2);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("retry reset"));
  });

  it("reports incomplete full reset when workspace cleanup fails", async () => {
    removeWorkspaceDirs.mockResolvedValueOnce(["/tmp/.openclaw/workspace"]);

    await expectIncomplete();
  });

  it("continues independent cleanup and reports incomplete reset when session cleanup fails", async () => {
    removeAgentSessions.mockRejectedValueOnce(new Error("permission denied"));

    await expectIncomplete("config+creds+sessions");

    expect(removePath.mock.calls.map(([target]) => target)).toEqual([
      "/tmp/.openclaw/openclaw.json",
      "/tmp/.openclaw/credentials",
    ]);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
    expect(runtime.error).toHaveBeenLastCalledWith(
      "Reset incomplete. Resolve the cleanup errors above, then retry reset.",
    );
  });
});
