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
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";

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
    ({ db }) => {
      // Bootstrap persisted input independently of the reader's row conversion.
      db.prepare(`INSERT INTO claw_package_refs (
      schema_version, agent_id, claw_name, package_kind, package_source, package_ref,
      package_version, package_integrity, package_status, relationship, origin,
      independent_owner, extension_id, extension_format, extension_detected_format,
      extension_mapped_json, extension_unavailable_json, extension_adapter_identity,
      installed_at_ms, updated_at_ms
    ) VALUES ('openclaw.clawPackageRef.v1', ?, ?, 'plugin', 'clawhub', '@openclaw/tools',
      '1.0.0', 'sha256:fixture', 'complete', 'referenced', 'pre-existing', 1,
      'tools', 'claude', 'claude', '["commands","skills"]', '["agents"]', 'openclaw/v1', 123, 123)
    `).run(plan.agent.finalId, plan.claw.name);
    },
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
