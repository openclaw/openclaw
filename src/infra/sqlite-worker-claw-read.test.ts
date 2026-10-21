import { existsSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readClawInventory } from "../claws/inventory-read.js";
import type { PersistedClawPackageRef } from "../claws/package-extension-provenance.js";
import {
  makeProvenancePlan,
  seedLegacyClawInstall,
  stateEnv,
} from "../claws/provenance.test-helpers.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

const emptyInventory = {
  installs: [],
  packages: [],
  workspaceFiles: [],
  mcpServers: [],
  cronJobs: [],
};

it.each([false, true])("reads an empty inventory (existing database: %s)", async (existing) => {
  const captured = captureOpenClawStateWorkerContext({
    env: { OPENCLAW_STATE_DIR: dirs.make("openclaw-claw-worker-read-") },
  });
  const options = { path: captured.admission.databasePath, env: captured.environment };
  if (existing) {
    openOpenClawStateDatabase(options);
    await closeOpenClawStateDatabaseAsync();
  }
  await expect(readClawInventory(options)).resolves.toEqual(emptyInventory);
  expect(existsSync(options.path)).toBe(existing);
});

it("preserves installed Claw and plugin extension facts through the read-only worker", async () => {
  const root = dirs.make("openclaw-claw-inventory-");
  const env = stateEnv(root);
  const { plan } = await makeProvenancePlan(root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  const install = seedLegacyClawInstall(plan, { env });
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "claw_package_refs">>(db)
          .insertInto("claw_package_refs")
          .values({
            schema_version: "openclaw.clawPackageRef.v1",
            agent_id: plan.agent.finalId,
            claw_name: plan.claw.name,
            package_kind: "plugin",
            package_source: "clawhub",
            package_ref: "@openclaw/tools",
            package_version: "1.0.0",
            package_integrity: "sha256:fixture",
            package_status: "complete",
            relationship: "referenced",
            origin: "pre-existing",
            independent_owner: 1,
            extension_id: "tools",
            extension_format: "claude",
            extension_detected_format: "claude",
            extension_mapped_json: '["commands","skills"]',
            extension_unavailable_json: '["agents"]',
            extension_adapter_identity: "openclaw/v1",
            installed_at_ms: 123,
            updated_at_ms: 123,
          }),
      ),
    { env },
  );
  const pkg: PersistedClawPackageRef = {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: plan.agent.finalId,
    clawName: plan.claw.name,
    kind: "plugin",
    source: "clawhub",
    ref: "@openclaw/tools",
    version: "1.0.0",
    integrity: "sha256:fixture",
    status: "complete",
    relationship: "referenced",
    origin: "pre-existing",
    independentOwner: true,
    extension: {
      id: "tools",
      format: "claude",
      detectedFormat: "claude",
      mapped: ["commands", "skills"],
      unavailable: ["agents"],
      adapterIdentity: "openclaw/v1",
    },
    installedAtMs: 123,
    updatedAtMs: 123,
  };
  await closeOpenClawStateDatabaseAsync();

  await expect(readClawInventory({ env })).resolves.toEqual({
    ...emptyInventory,
    installs: [install],
    packages: [pkg],
  });
});
