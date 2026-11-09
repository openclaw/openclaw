import fs, { promises as fsPromises } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  fingerprintConfigSnapshotAuthoredConfig,
  readLatestConfigSnapshotAuditRecordAsync,
  restoreConfigSnapshotAuditRecordAsync,
  upsertConfigSnapshotAuditRecordAsync,
} from "./config-journal-snapshot.js";
import {
  CONFIG_SNAPSHOT_KEY,
  CONFIG_SNAPSHOT_SCOPE,
  type ConfigSnapshotAuditRecord as Snapshot,
} from "./config-journal-snapshot.kernel.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-config-journal-snapshot-" });

beforeAll(() => tempDirs.setup());

async function fixture(name: string) {
  const home = await tempDirs.make(name);
  const stateDir = path.join(home, ".openclaw");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const context = { env, homedir: () => home };
  const configPath = path.join(stateDir, "openclaw.json");
  const write = (
    rawHash: string,
    port: number,
    options: { configPath?: string; expectedSnapshot?: Snapshot | null } = {},
    assertCurrent?: () => void,
  ) =>
    upsertConfigSnapshotAuditRecordAsync(
      { ...context, configPath, rawHash, authoredConfig: { gateway: { port } }, ...options },
      assertCurrent,
    );
  const restore = (
    snapshot: Snapshot | null,
    expectedSnapshot: Snapshot | null,
    assertCurrent?: () => void,
  ) =>
    restoreConfigSnapshotAuditRecordAsync(
      { ...context, snapshot, expectedSnapshot },
      assertCurrent,
    );
  const read = () => readLatestConfigSnapshotAuditRecordAsync(context);
  return { stateDir, env, context, configPath, write, restore, read };
}

it("fingerprints every snapshot leaf with a per-install key", async () => {
  const { stateDir, context } = await fixture("fingerprint-home");
  const fingerprinted = fingerprintConfigSnapshotAuthoredConfig(
    { gateway: { auth: { token: "test-token" }, port: 18789 } },
    context,
  );

  expect(fingerprinted).toMatchObject({
    gateway: {
      auth: { token: expect.stringMatching(/^fp:[0-9a-f]{12}$/) },
      port: expect.stringMatching(/^fp:[0-9a-f]{12}$/),
    },
  });
  expect(JSON.stringify(fingerprinted)).not.toContain("test-token");
  expect(fs.statSync(path.join(stateDir, "config-journal-fingerprint.key")).mode & 0o777).toBe(
    0o600,
  );

  const fingerprintOf = (value: unknown) =>
    (fingerprintConfigSnapshotAuthoredConfig({ leaf: value }, context) as { leaf: string }).leaf;
  const variants = ["1", 1, true, "true"].map(fingerprintOf);
  expect(new Set(variants).size).toBe(variants.length);
  expect(fingerprintOf("1")).toBe(fingerprintOf("1"));
});

it("hands the snapshot slot to another config path via the unfiltered CAS token", async () => {
  const { stateDir, write, read } = await fixture("snapshot-path-transfer");
  const pathA = path.join(stateDir, "config-a.json");
  const pathB = path.join(stateDir, "config-b.json");
  await write("path-a-hash", 1, { configPath: pathA });
  const foreign = await read();
  expect(foreign?.configPath).toBe(path.resolve(pathA));
  const taken = await write("path-b-hash", 2, { configPath: pathB, expectedSnapshot: foreign });
  expect(taken?.configPath).toBe(path.resolve(pathB));
  expect((await read())?.rawHash).toBe("path-b-hash");
});

it("preserves another writer's snapshot across queued publication and rollback", async () => {
  const { configPath, env, write, restore, read } = await fixture("snapshot-compare-and-set");
  const prior = await write("prior", 18789);
  const written = await write("written", 18790);
  expect(written).not.toBeNull();
  const pending = write("queued", 18792, { configPath, expectedSnapshot: written });
  // A separate native writer can advance the slot while this actor is queued.
  createSqliteAuditRecordStore<Snapshot>({
    scope: CONFIG_SNAPSHOT_SCOPE,
    maxEntries: 1,
    env,
  }).upsert(CONFIG_SNAPSHOT_KEY, {
    configPath,
    rawHash: "newer-process",
    fingerprintedAuthoredConfig: {},
  });
  await expect(pending).resolves.toBeNull();

  await restore(prior, written);

  expect((await read())?.rawHash).toBe("newer-process");
});

it.each(["publication", "restoration"] as const)(
  "refuses queued %s after its owner is revoked",
  async (operation) => {
    const { write, restore, read } = await fixture("snapshot-revoked-publication");
    const prior = await write("prior", 18789);
    expect(prior).not.toBeNull();
    let revoked = false;
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("Config source owner stopped");
      }
    };
    const pending =
      operation === "publication"
        ? write("revoked", 1, { expectedSnapshot: prior }, assertCurrent)
        : restore(null, prior, assertCurrent);
    revoked = true;
    await expect(pending).rejects.toThrow("Config source owner stopped");
    expect(await read()).toEqual(prior);
  },
);

it.each([false, true])("restores a prior snapshot off thread (existing=%s)", async (existing) => {
  const { read, write, restore } = await fixture("snapshot-restoration");
  const sql = observeMainThreadSql();
  sql.calibrate();
  try {
    const prior = existing ? await write("prior", 18789) : null;
    const written = await write("written", 18790);
    expect(written).not.toBeNull();
    await restore(prior, written);
    expect(await read()).toEqual(prior);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("falls back to a redaction marker when the fingerprint key cannot be stored", async () => {
  const home = await tempDirs.make("fingerprint-fallback");
  const statePath = path.join(home, "state-file");
  await fsPromises.writeFile(statePath, "not a directory", "utf-8");

  expect(
    fingerprintConfigSnapshotAuthoredConfig(
      { gateway: { auth: { token: "test-token" } } },
      { env: { OPENCLAW_STATE_DIR: statePath }, homedir: () => home },
    ),
  ).toEqual({ gateway: { auth: { token: "***" } } });
});

afterAll(() => tempDirs.cleanup());

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});
