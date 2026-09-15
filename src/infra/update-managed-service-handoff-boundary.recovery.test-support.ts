import fs from "node:fs/promises";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";

export async function prepareManagedServiceRecoveryFixture({
  root,
  statePath,
  recoveryModulePath,
  options,
}: {
  root: string;
  statePath: string;
  recoveryModulePath: string;
  options?: ManagedServiceBoundaryOptions;
}) {
  const stateDatabasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: root });
  const consumeNotification = `const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)}); const cleared = db.prepare("DELETE FROM gateway_restart_sentinel WHERE sentinel_key = 'current'").run(); db.close(); if (cleared.changes !== 1) throw new Error("expected one published notification before recovery consumed it"); ${managedServiceStateUpdateScript(statePath, "state.consumedNotifications = Number(cleared.changes)")};`;
  if (options?.updaterNotification) {
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  }
  await fs.writeFile(
    recoveryModulePath,
    `
    import fs from "node:fs";
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    export async function waitForGatewayUpdateRecovery(expectedVersion, expectedBuildId) {
      ${managedServiceStateUpdateScript(
        statePath,
        `
      state.healthProbed = true;
      state.healthProbeCount = (state.healthProbeCount || 0) + 1;
      state.expectedVersion = expectedVersion;
      state.expectedBuildId = expectedBuildId;
      `,
      )};
      ${options?.updaterNotification === "consumed" ? consumeNotification : ""}
      ${options?.diagnosticReadFailure === "after-recovery" ? `{ const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)}); db.exec("ALTER TABLE gateway_restart_sentinel RENAME COLUMN thread_id TO unreadable_thread_id"); db.close(); }` : ""}
      const fault = ${JSON.stringify(options?.gatewayHealth)};
      if (fault === "throw") throw new Error("readiness probe unavailable");
      return { healthy: !["unready", "wrong-version", "wrong-build", "exited"].includes(fault),
        runtime: { status: fault === "exited" ? "stopped" : "running", pid: fault === "exited" ? null : ${process.pid} },
        gatewayVersion: fault === "wrong-version" ? "0.0.1" : expectedVersion,
        gatewayBuildId: fault === "wrong-build" ? "another-build-same-version" : expectedBuildId };
    }
  `,
  );
  return { stateDatabasePath, consumeNotification };
}
