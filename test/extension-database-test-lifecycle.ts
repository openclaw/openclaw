import { vi } from "vitest";

/** Close Worker resources, native agent leases, and shared state before removing a test home. */
export async function cleanupExtensionTestHome(cleanup: () => void): Promise<void> {
  const { drainAgentDatabaseResources } = await vi.importActual<
    typeof import("../src/state/openclaw-agent-db-resources.js")
  >("../src/state/openclaw-agent-db-resources.js");
  // File-owned homes must survive until retained Worker leases have been released.
  await drainAgentDatabaseResources({}, async () => {
    const owners = globalThis as Record<PropertyKey, unknown>;
    if (owners[Symbol.for("openclaw.agentDatabaseLifecycle")]) {
      const { closeOpenClawAgentDatabasesAsync } = await vi.importActual<
        typeof import("../src/state/openclaw-agent-db-lifecycle.js")
      >("../src/state/openclaw-agent-db-lifecycle.js");
      // Native agent handles also own durable leases in shared state. Release
      // those leases before closing shared state or removing the fixture home.
      await closeOpenClawAgentDatabasesAsync();
    }
    if (owners[Symbol.for("openclaw.stateDatabaseLifecycle")]) {
      const { closeOpenClawStateDatabaseAsync } = await vi.importActual<
        typeof import("../src/state/openclaw-state-db-cache.js")
      >("../src/state/openclaw-state-db-cache.js");
      await closeOpenClawStateDatabaseAsync();
    }
    cleanup();
  });
}
