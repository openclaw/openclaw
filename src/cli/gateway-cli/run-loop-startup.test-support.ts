import { expect, it, vi } from "vitest";
import { GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON } from "../../infra/startup-maintenance-required.js";
import { createRuntimeWithExitSignal, withIsolatedSignals } from "./run-loop.test-support.js";

export function registerGatewayStartupFailureTests(): void {
  it("keeps truncated startup failure reasons free of lone surrogates", async () => {
    await withIsolatedSignals(async () => {
      const failure = `${"a".repeat(499)}😀tail`;
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const { runGatewayLoop } = await import("./run-loop.js");
      await expect(
        runGatewayLoop({
          start: vi.fn(async () => {
            throw new Error(failure);
          }) as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
          completeBoot,
        }),
      ).rejects.toThrow(failure);

      const reason =
        (completeBoot.mock.calls[0]?.[0] as { reason?: string } | undefined)?.reason ?? "";
      expect(reason).toHaveLength(499);
      expect(Buffer.from(reason).toString()).toBe(reason);
    });
  });

  it.each([
    [
      "agent media",
      async () =>
        new (
          await import("../../state/openclaw-agent-db-migration-required.js")
        ).OpenClawAgentDatabaseMediaMigrationRequiredError("/tmp/agent.sqlite", 14),
    ],
    [
      "audit ledger",
      async () =>
        new (
          await import("../../state/openclaw-state-db-schema-migration-required.js")
        ).OpenClawStateDatabaseSchemaMigrationRequiredError("audit-events-v2", "/tmp/state.sqlite"),
    ],
    [
      "agent registry",
      async () =>
        new (
          await import("../../state/openclaw-state-db-schema-migration-required.js")
        ).OpenClawStateDatabaseSchemaMigrationRequiredError(
          "agent-databases-composite-primary-key",
          "/tmp/state.sqlite",
        ),
    ],
    [
      "session store",
      async () =>
        new (
          await import("../../config/sessions/migration-required.js")
        ).SessionStoreMigrationRequiredError("legacy session store"),
    ],
    [
      "newer schema",
      async () =>
        new (await import("../../infra/sqlite-user-version.js")).SqliteSchemaVersionError(
          "newer schema version",
        ),
    ],
  ] as const)(
    "records a maintenance reason for %s startup failures",
    async (_kind, createFailure) => {
      await withIsolatedSignals(async () => {
        // Earlier lifecycle tests reload the runtime; create the error in that same module graph.
        const failure = await createFailure();
        const { runtime } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const { runGatewayLoop } = await import("./run-loop.js");

        await expect(
          runGatewayLoop({
            start: vi.fn(async () => {
              throw failure;
            }) as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
            runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
            completeBoot,
          }),
        ).rejects.toBe(failure);

        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "startup_failed",
          reason: failure.message,
          startupReason: GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON,
        });
      });
    },
  );
}
