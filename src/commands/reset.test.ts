import { beforeEach, expect, it } from "vitest";
import * as cleanup from "./cleanup-command.test-support.js";
import { resetCommand } from "./reset.js";

const runtime = cleanup.createCleanupCommandRuntime();
const run = (scope: Parameters<typeof resetCommand>[1]["scope"] = "full", dryRun = false) =>
  resetCommand(runtime, { scope, yes: true, nonInteractive: true, dryRun });
const expectIncomplete = async (scope?: Parameters<typeof resetCommand>[1]["scope"]) => {
  await expect(run(scope)).rejects.toMatchObject({ name: "ExitError", code: 1 });
  expect(cleanup.cleanupCommandLogMessages(runtime).join("\n")).not.toMatch(/^Next:/m);
};

beforeEach(() => {
  cleanup.resetCleanupCommandMocks();
  cleanup.silenceCleanupCommandRuntime(runtime);
});

it.each(["isLoaded", "stop"] as const)(
  "preserves user data when gateway %s fails",
  async (method) => {
    cleanup.gatewayService[method].mockRejectedValue(new Error(`${method} failed`));

    await expect(run()).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(cleanup.removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(cleanup.removeWorkspaceDirs).not.toHaveBeenCalled();
  },
);

it("stops the managed Gateway before loading the destructive cleanup plan", async () => {
  cleanup.gatewayService.stop.mockImplementation(async () => {
    expect(cleanup.resolveCleanupPlanForRemoval).not.toHaveBeenCalled();
  });

  await run();

  expect(cleanup.resolveCleanupPlanForRemoval).toHaveBeenCalledOnce();
});

it("refuses reset while an unmanaged Gateway holds the state directory", async () => {
  cleanup.gatewayService.isLoaded.mockResolvedValue(false);
  cleanup.gatewayOwnerLease.readGatewayOwnerLease.mockReturnValue({
    state: "live",
    pid: 4242,
    owner: "test-owner",
    port: 4096,
    mode: "foreground",
    supervisor: null,
    expired: false,
    host: "local",
    startedAt: 0,
  });

  await expect(run()).rejects.toMatchObject({ name: "ExitError", code: 1 });
  expect(cleanup.removeStateAndLinkedPaths).not.toHaveBeenCalled();
  expect(cleanup.removeWorkspaceDirs).not.toHaveBeenCalled();
  expect(cleanup.cleanupCommandErrorMessages(runtime).join("\n")).toContain(
    "A Gateway is still running (pid 4242)",
  );
});

it("proceeds with reset when no Gateway owns the state directory", async () => {
  cleanup.gatewayService.isLoaded.mockResolvedValue(false);
  cleanup.gatewayOwnerLease.readGatewayOwnerLease.mockReturnValue(undefined);

  await run();

  expect(cleanup.removeStateAndLinkedPaths).toHaveBeenCalledOnce();
});

it.each([
  ["config+creds+sessions", true],
  ["config", false],
] as const)("recommends backup for %s: %s", async (scope, expected) => {
  await run(scope, true);
  const logs = cleanup.cleanupCommandLogMessages(runtime);
  expect(logs.some((message) => message.includes("openclaw backup create"))).toBe(expected);
});

it.each([
  ["state", cleanup.removeStateAndLinkedPaths, false],
  ["workspace", cleanup.removeWorkspaceDirs, ["/tmp/.openclaw/workspace"]],
] as const)("reports incomplete full reset when %s cleanup fails", async (kind, remove, result) => {
  remove.mockResolvedValueOnce(result);
  await expectIncomplete();
  if (kind === "state") {
    expect(cleanup.removeWorkspaceDirs.mock.lastCall?.[2]).toMatchObject({
      dryRun: false,
      removeStateRows: true,
    });
  }
});

it.each([
  { scope: "config" as const, failedRemoval: 0 },
  { scope: "config+creds+sessions" as const, failedRemoval: 0 },
  { scope: "config+creds+sessions" as const, failedRemoval: 1 },
])("reports failed removal $failedRemoval for $scope", async ({ scope, failedRemoval }) => {
  for (let index = 0; index < failedRemoval; index++) {
    cleanup.removePath.mockResolvedValueOnce({ ok: true });
  }
  cleanup.removePath.mockResolvedValueOnce({ ok: false });

  await expectIncomplete(scope);

  expect(cleanup.removePath).toHaveBeenCalledTimes(scope === "config" ? 1 : 2);
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("retry reset"));
});
