import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultPayload } from "./gateway-state-owner-record.js";
import { acquireGatewayStateOwner, resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { startSqliteCheckpointWriter } from "./sqlite-checkpoint-writer.test-support.js";
import * as copies from "./sqlite-file-copy.js";
import { prepareSqliteReadOnlyCopyInProcess } from "./sqlite-readonly-location.js";
import { MAX_SNAPSHOT_ATTEMPTS } from "./sqlite-snapshot-policy.js";
import { prepareSqliteReadOnlyLocationAwaited as prepareSnapshot } from "./sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  }),
);

it("snapshots a verified live writer once despite checkpoints that exhaust raw-copy retries", async () => {
  const root = roots.make("sqlite-live-metadata-");
  const source = path.join(root, "state", "openclaw.sqlite");
  const staging = path.join(root, "staging");
  fs.mkdirSync(path.dirname(source));
  fs.mkdirSync(staging);
  const writer = await startSqliteCheckpointWriter(source);
  const owner = acquireGatewayStateOwner({
    databasePath: source,
    payload: { ...defaultPayload(source), role: "gateway" },
  });
  try {
    const copy = copies.copySqliteFile;
    const raw = vi.spyOn(copies, "copySqliteFile").mockImplementation(async (...args) => {
      const result = await copy(...args);
      // Each copy overlaps a real checkpoint in the independent writer process.
      await writer.commit();
      return result;
    });
    await expect(prepareSqliteReadOnlyCopyInProcess(source, staging)).rejects.toThrow(
      `did not stabilize after ${MAX_SNAPSHOT_ATTEMPTS}`,
    );
    expect(raw).toHaveBeenCalledTimes(MAX_SNAPSHOT_ATTEMPTS);
    raw.mockRestore();
    const prepared = await prepareSnapshot(source, snapshotOptions(source));
    try {
      using db = new (requireNodeSqlite().DatabaseSync)(prepared.location, { readOnly: true });
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      const rows = db.prepare("SELECT generation FROM snapshot_pair ORDER BY id").all();
      expect(rows[0]?.generation).toBeGreaterThan(0);
      expect(rows[0]).toEqual(rows[1]);
      expect(db.prepare("SELECT length(data) AS bytes FROM snapshot_payload").get()).toEqual({
        bytes: 33554432,
      });
      const directory = path.dirname(prepared.location);
      const retainedBytes = fs
        .readdirSync(directory)
        .reduce((bytes, name) => bytes + fs.statSync(path.join(directory, name)).size, 0);
      expect(retainedBytes).toBeLessThan(34 * 1024 * 1024);
    } finally {
      expect(await prepared.cleanupAsync()).toBe(true);
    }
    expect(fs.readdirSync(staging)).toEqual([]);
  } finally {
    await writer.stop();
    owner.release();
  }
});

it.each(["absent", "unverifiable"])(
  "keeps %s ownership byte-neutral, refuses unknown holders, and rejects a replaced source identity",
  async (owner) => {
    const root = roots.make("sqlite-offline-metadata-");
    const source = path.join(root, "openclaw.sqlite");
    {
      using db = new (requireNodeSqlite().DatabaseSync)(source);
      db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE probe(value); INSERT INTO probe VALUES('offline');",
      );
    }
    if (owner === "unverifiable") {
      const ownerPath = resolveGatewayStateOwnerPath(source);
      fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
      fs.writeFileSync(
        ownerPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: path.join(root, "openclaw.json"),
          role: "gateway",
        }),
      );
    }
    const entries = fs.readdirSync(root);
    const before = fs.readFileSync(source);
    const options = snapshotOptions(source);
    if (owner === "unverifiable") {
      await expect(prepareSnapshot(source, options)).rejects.toThrow(
        "cannot verify Gateway ownership from this process",
      );
    } else {
      const prepared = await prepareSnapshot(source, options);
      expect(await prepared.cleanupAsync()).toBe(true);
    }
    expect(fs.readFileSync(source)).toEqual(before);
    expect(fs.readdirSync(root)).toEqual(entries);
    fs.renameSync(source, path.join(root, "original.sqlite"));
    fs.writeFileSync(source, before);
    await expect(prepareSnapshot(source, options)).rejects.toThrow(/identity changed/);
  },
);

function snapshotOptions(source: string) {
  return {
    signal: new AbortController().signal,
    expectedSourceIdentity: readDatabasePathIdentitySync(source),
    allowLiveOwner: true,
  };
}
