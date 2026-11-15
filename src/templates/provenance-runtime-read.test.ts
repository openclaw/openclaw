import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  prepareTemplateInstallSchemaVersions,
  readCachedTemplateInstallSchemaVersions,
} from "./provenance-runtime-read.js";
import { makeProvenancePlan, seedLegacyTemplateInstall } from "./provenance.test-helpers.js";

const tempDirs = createTempDirTracker();
const emptyOwnership = { kind: "ready", schemaVersions: new Map() };
const snapshot = async (options: Parameters<typeof prepareTemplateInstallSchemaVersions>[0]) => {
  (await prepareTemplateInstallSchemaVersions(options)).publish();
  return readCachedTemplateInstallSchemaVersions(options);
};
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("Template runtime provenance cache", () => {
  it.each(["absent", "existing"])(
    "reads empty %s state without WAL/SHM sidecars",
    async (state) => {
      const root = tempDirs.make("openclaw-template-runtime-provenance-empty-");
      const options = { env: { OPENCLAW_STATE_DIR: root } };
      if (state === "existing") {
        openOpenClawStateDatabase(options);
        closeOpenClawStateDatabaseForTest();
      }
      expect(await snapshot(options)).toMatchObject(emptyOwnership);
      const stateFile = join(root, "state", "openclaw.sqlite");
      expect(["-wal", "-shm"].map((suffix) => existsSync(stateFile + suffix))).toEqual([
        false,
        false,
      ]);
    },
  );

  it("reloads legacy ownership after closure and fails closed when the database disappears", async () => {
    const root = tempDirs.make("openclaw-template-runtime-provenance-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    const database = openOpenClawStateDatabase(options);

    expect(await snapshot(options)).toMatchObject(emptyOwnership);

    const { plan } = await makeProvenancePlan(root, { schemaVersion: 1, agent: { id: "worker" } });
    const { schemaVersion, agentConfigDigest } = seedLegacyTemplateInstall(plan, options);
    await closeOpenClawStateDatabaseAsync();
    expect(await snapshot(options)).toMatchObject({
      kind: "ready",
      schemaVersions: new Map([["worker", { kind: "ok", schemaVersion, agentConfigDigest }]]),
    });

    runOpenClawStateWriteTransaction(
      ({ db }) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "template_installs">>(db)
            .deleteFrom("template_installs")
            .where("agent_id", "=", "worker"),
        ),
      options,
    );
    await closeOpenClawStateDatabaseAsync();
    expect(await snapshot(options)).toEqual(emptyOwnership);

    seedLegacyTemplateInstall(plan, options);
    await closeOpenClawStateDatabaseAsync();
    (await prepareTemplateInstallSchemaVersions(options)).publish();

    openOpenClawStateDatabase(options);
    await closeOpenClawStateDatabaseAsync();
    rmSync(database.path);
    expect(await snapshot(options)).toMatchObject({
      kind: "state-error",
      knownAgentIds: new Set(["worker"]),
      ownershipUnknown: true,
    });
  });
});
