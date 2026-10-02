import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readClawInventory } from "../claws/inventory-read.js";
import { persistClawInstallRecord, persistClawPackageRef } from "../claws/provenance.js";
import { makeProvenancePlan, stateEnv } from "../claws/provenance.test-helpers.js";
import { readClawRemoveFacts } from "../claws/remove-facts-read.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function context() {
  return captureOpenClawStateWorkerContext({
    env: { OPENCLAW_STATE_DIR: dirs.make("openclaw-claw-worker-read-") },
  });
}

describe("Claw read-only worker", () => {
  it("does not create shared state for a missing Claw inventory", async () => {
    const captured = context();
    await expect(
      readClawInventory({ path: captured.admission.databasePath, env: captured.environment }),
    ).resolves.toEqual({
      installs: [],
      packages: [],
      workspaceFiles: [],
      mcpServers: [],
      cronJobs: [],
    });
    expect(existsSync(captured.admission.databasePath)).toBe(false);
  });

  it("reads an empty Claw inventory through the independent read-only worker", async () => {
    const initial = context();
    openOpenClawStateDatabase({
      path: initial.admission.databasePath,
      env: initial.environment,
    });
    await closeOpenClawStateDatabaseAsync();

    await expect(
      readClawInventory({ path: initial.admission.databasePath, env: initial.environment }),
    ).resolves.toEqual({
      installs: [],
      packages: [],
      workspaceFiles: [],
      mcpServers: [],
      cronJobs: [],
    });
  });

  it("preserves installed Claw and plugin extension facts through the read-only worker", async () => {
    const root = dirs.make("openclaw-claw-inventory-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const install = persistClawInstallRecord(plan, { env, nowMs: 123 });
    const pkg = persistClawPackageRef(
      plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@openclaw/tools",
        version: "1.0.0",
        integrity: "sha256:fixture",
        extension: {
          id: "tools",
          format: "claude",
          detectedFormat: "claude",
          mapped: ["commands", "skills"],
          unavailable: ["agents"],
          adapterIdentity: "openclaw/v1",
        },
      },
      { env, nowMs: 123, origin: "pre-existing", independentOwner: true },
    );
    await closeOpenClawStateDatabaseAsync();

    await expect(readClawInventory({ env })).resolves.toEqual({
      installs: [install],
      packages: [pkg],
      workspaceFiles: [],
      mcpServers: [],
      cronJobs: [],
    });
  });

  it("reads removal safety facts without opening agent databases on the host", async () => {
    const initial = context();
    openOpenClawStateDatabase({
      path: initial.admission.databasePath,
      env: initial.environment,
    });
    await closeOpenClawStateDatabaseAsync();
    const missingSessionStore = path.join(
      path.dirname(initial.admission.databasePath),
      "missing-agent.sqlite",
    );

    await expect(
      readClawRemoveFacts("worker", [missingSessionStore], {
        path: initial.admission.databasePath,
        env: initial.environment,
      }),
    ).resolves.toEqual({
      attachedJobs: [],
      cronRefs: [],
      install: null,
      journal: null,
      sessionStoreOwners: [{ path: missingSessionStore, owner: { status: "unreadable" } }],
    });
    expect(existsSync(missingSessionStore)).toBe(false);
  });
});
