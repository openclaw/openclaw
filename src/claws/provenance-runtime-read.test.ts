import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  prepareClawInstallSchemaVersions,
  readCachedClawInstallSchemaVersions,
} from "./provenance-runtime-read.js";
import { makeProvenancePlan, seedLegacyClawInstall } from "./provenance.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const emptyOwnership = { kind: "ready", schemaVersions: new Map() };
async function snapshot(options: Parameters<typeof prepareClawInstallSchemaVersions>[0]) {
  (await prepareClawInstallSchemaVersions(options)).publish();
  return readCachedClawInstallSchemaVersions(options);
}
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

describe("Claw runtime provenance cache", () => {
  it("treats an absent first-run state database as empty ownership", async () => {
    const root = tempDirs.make("openclaw-claw-runtime-provenance-first-run-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };

    expect(await snapshot(options)).toMatchObject(emptyOwnership);
  });

  it("reloads legacy ownership after closure and fails closed when the database disappears", async () => {
    const root = tempDirs.make("openclaw-claw-runtime-provenance-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    const database = openOpenClawStateDatabase(options);

    expect(await snapshot(options)).toMatchObject(emptyOwnership);

    const { plan } = await makeProvenancePlan(root, { schemaVersion: 1, agent: { id: "worker" } });
    const record = seedLegacyClawInstall(plan, options);
    await closeOpenClawStateDatabaseAsync();
    const refreshed = await snapshot(options);
    assert(refreshed.kind === "ready", "expected ready Claw provenance snapshot");
    expect(refreshed.schemaVersions.get("worker")).toMatchObject({
      kind: "ok",
      schemaVersion: record.schemaVersion,
      agentConfigDigest: record.agentConfigDigest,
    });

    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "claw_installs">>(db)
          .deleteFrom("claw_installs")
          .where("agent_id", "=", "worker"),
      );
    }, options);
    await closeOpenClawStateDatabaseAsync();
    expect(await snapshot(options)).toEqual(emptyOwnership);

    seedLegacyClawInstall(plan, options);
    await closeOpenClawStateDatabaseAsync();
    (await prepareClawInstallSchemaVersions(options)).publish();

    openOpenClawStateDatabase(options);
    await closeOpenClawStateDatabaseAsync();
    rmSync(database.path);
    expect(await snapshot(options)).toMatchObject({
      kind: "state-error",
      knownAgentIds: new Set(["worker"]),
      ownershipUnknown: true,
    });
  });

  it("does not create WAL/SHM sidecar files when reading schema versions", async () => {
    const root = tempDirs.make("openclaw-claw-runtime-provenance-sidecar-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    const database = openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    expect(await snapshot(options)).toMatchObject(emptyOwnership);

    const stateDir = join(root, "state");
    expect(existsSync(join(stateDir, "openclaw.sqlite-wal"))).toBe(false);
    expect(existsSync(join(stateDir, "openclaw.sqlite-shm"))).toBe(false);

    await closeOpenClawStateDatabaseAsync();
    rmSync(database.path);
  });
});
