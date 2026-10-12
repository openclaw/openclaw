import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as kysely from "../infra/kysely-sync.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  initializeCachedClawInstallSchemaVersions,
  readCachedClawInstallSchemaVersions,
} from "./provenance-runtime-read.js";
import { deleteClawInstallRecord, persistClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan } from "./provenance.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("Claw runtime provenance cache", () => {
  it("treats an absent first-run state database as empty ownership", () => {
    const root = tempDirs.make("openclaw-claw-runtime-provenance-first-run-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };

    initializeCachedClawInstallSchemaVersions(options);

    expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
      kind: "ready",
      schemaVersions: new Map(),
    });
  });

  it("reuses committed install and deletion facts until the database closes", async () => {
    const root = tempDirs.make("openclaw-claw-runtime-provenance-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    const database = openOpenClawStateDatabase(options);

    initializeCachedClawInstallSchemaVersions(options);
    expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
      kind: "ready",
      schemaVersions: new Map(),
    });

    const { plan } = await makeProvenancePlan(root, { schemaVersion: 1, agent: { id: "worker" } });
    const record = persistClawInstallRecord(plan, options);
    const query = vi.spyOn(kysely, "executeSqliteQuerySync");
    initializeCachedClawInstallSchemaVersions(options);
    expect(query).not.toHaveBeenCalled();
    const refreshed = readCachedClawInstallSchemaVersions(options);
    expect(refreshed.kind).toBe("ready");
    if (refreshed.kind !== "ready") {
      throw new Error("expected ready Claw provenance snapshot");
    }
    expect(refreshed.schemaVersions.get("worker")).toMatchObject({
      kind: "ok",
      schemaVersion: record.schemaVersion,
      agentConfigDigest: record.agentConfigDigest,
    });

    deleteClawInstallRecord("worker", options);
    query.mockClear();
    initializeCachedClawInstallSchemaVersions(options);
    expect(query).not.toHaveBeenCalled();
    expect(readCachedClawInstallSchemaVersions(options)).toEqual({
      kind: "ready",
      schemaVersions: new Map(),
    });

    persistClawInstallRecord(plan, options);

    closeOpenClawStateDatabaseForTest();
    rmSync(database.path);
    initializeCachedClawInstallSchemaVersions(options);
    expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
      kind: "state-error",
      knownAgentIds: new Set(["worker"]),
      ownershipUnknown: true,
    });
  });

  it("does not create WAL/SHM sidecar files when reading schema versions", () => {
    const root = tempDirs.make("openclaw-claw-runtime-provenance-sidecar-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    const database = openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");

    initializeCachedClawInstallSchemaVersions(options);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
      kind: "ready",
      schemaVersions: new Map(),
    });

    const stateDir = join(root, "state");
    expect(existsSync(join(stateDir, "openclaw.sqlite-wal"))).toBe(false);
    expect(existsSync(join(stateDir, "openclaw.sqlite-shm"))).toBe(false);

    rmSync(database.path);
  });
});
