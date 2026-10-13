// Covers config journal snapshot fingerprints, slot ownership, and restoration.
import fs, { promises as fsPromises } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  type ConfigSnapshotAuditRecord,
} from "./config-journal-snapshot.kernel.js";

describe("config journal snapshots", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-config-journal-snapshot-",
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  it("fingerprints every snapshot leaf with a per-install key", async () => {
    const home = await suiteRootTracker.make("fingerprint-home");
    const stateDir = path.join(home, ".openclaw");
    const fingerprinted = fingerprintConfigSnapshotAuthoredConfig(
      {
        gateway: { auth: { token: "test-token" }, port: 18789 },
      },
      {
        env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
        homedir: () => home,
      },
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

    // Type-only edits must change the fingerprint: "1" vs 1 vs true vs "true".
    const context = {
      env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      homedir: () => home,
    };
    const fingerprintOf = (value: unknown) =>
      (fingerprintConfigSnapshotAuthoredConfig({ leaf: value }, context) as { leaf: string }).leaf;
    const variants = [
      fingerprintOf("1"),
      fingerprintOf(1),
      fingerprintOf(true),
      fingerprintOf("true"),
    ];
    expect(new Set(variants).size).toBe(variants.length);
    expect(fingerprintOf("1")).toBe(fingerprintOf("1"));
  });

  it("hands the snapshot slot to another config path via the unfiltered CAS token", async () => {
    const home = await suiteRootTracker.make("snapshot-path-transfer");
    const env = { OPENCLAW_STATE_DIR: path.join(home, ".openclaw") } as NodeJS.ProcessEnv;
    const context = { env, homedir: () => home };
    const pathA = path.join(home, ".openclaw", "config-a.json");
    const pathB = path.join(home, ".openclaw", "config-b.json");
    await upsertConfigSnapshotAuditRecordAsync({
      ...context,
      configPath: pathA,
      rawHash: "path-a-hash",
      authoredConfig: { gateway: { port: 1 } },
    });
    // The unfiltered slot is the CAS token that lets B take the slot over from A.
    const foreign = await readLatestConfigSnapshotAuditRecordAsync(context);
    expect(foreign?.configPath).toBe(path.resolve(pathA));
    const taken = await upsertConfigSnapshotAuditRecordAsync({
      ...context,
      configPath: pathB,
      rawHash: "path-b-hash",
      authoredConfig: { gateway: { port: 2 } },
      expectedSnapshot: foreign,
    });
    expect(taken?.configPath).toBe(path.resolve(pathB));
    expect((await readLatestConfigSnapshotAuditRecordAsync(context))?.rawHash).toBe("path-b-hash");
  });

  it("preserves another writer's snapshot across queued publication and rollback", async () => {
    const home = await suiteRootTracker.make("snapshot-compare-and-set");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const env = { OPENCLAW_STATE_DIR: path.join(home, ".openclaw") } as NodeJS.ProcessEnv;
    const context = { env, homedir: () => home };
    const prior = await upsertConfigSnapshotAuditRecordAsync({
      ...context,
      configPath,
      rawHash: "prior",
      authoredConfig: { gateway: { port: 18789 } },
    });
    const written = await upsertConfigSnapshotAuditRecordAsync({
      ...context,
      configPath,
      rawHash: "written",
      authoredConfig: { gateway: { port: 18790 } },
    });
    expect(written).not.toBeNull();
    const pending = upsertConfigSnapshotAuditRecordAsync({
      ...context,
      configPath,
      rawHash: "queued",
      authoredConfig: { gateway: { port: 18792 } },
      expectedSnapshot: written,
    });
    // A separate native writer can advance the slot while this actor is queued.
    createSqliteAuditRecordStore<ConfigSnapshotAuditRecord>({
      scope: CONFIG_SNAPSHOT_SCOPE,
      maxEntries: 1,
      env,
    }).upsert(CONFIG_SNAPSHOT_KEY, {
      configPath,
      rawHash: "newer-process",
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig(
        { gateway: { port: 18791 } },
        context,
      ),
    });
    await expect(pending).resolves.toBeNull();

    await restoreConfigSnapshotAuditRecordAsync({
      ...context,
      snapshot: prior,
      expectedSnapshot: written,
    });

    expect(await readLatestConfigSnapshotAuditRecordAsync(context)).toMatchObject({
      rawHash: "newer-process",
    });
  });

  it.each(["publication", "restoration"] as const)(
    "refuses queued %s after its owner is revoked",
    async (operation) => {
      const home = await suiteRootTracker.make("snapshot-revoked-publication");
      const env = { OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const context = { env, homedir: () => home };
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const prior = await upsertConfigSnapshotAuditRecordAsync({
        ...context,
        configPath,
        rawHash: "prior",
        authoredConfig: { gateway: { port: 18789 } },
      });
      expect(prior).not.toBeNull();
      let revoked = false;
      const assertCurrent = () => {
        if (revoked) {
          throw new Error("Config source owner stopped");
        }
      };
      const pending =
        operation === "publication"
          ? upsertConfigSnapshotAuditRecordAsync(
              {
                ...context,
                configPath,
                rawHash: "revoked",
                authoredConfig: {},
                expectedSnapshot: prior,
              },
              assertCurrent,
            )
          : restoreConfigSnapshotAuditRecordAsync(
              { ...context, snapshot: null, expectedSnapshot: prior },
              assertCurrent,
            );
      revoked = true;
      await expect(pending).rejects.toThrow("Config source owner stopped");
      expect(await readLatestConfigSnapshotAuditRecordAsync(context)).toEqual(prior);
    },
  );

  it.each([false, true])("restores a prior snapshot off thread (existing=%s)", async (existing) => {
    const home = await suiteRootTracker.make("snapshot-restoration");
    const env = { OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
    const context = { env, homedir: () => home };
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      const prior = existing
        ? await upsertConfigSnapshotAuditRecordAsync({
            ...context,
            configPath,
            rawHash: "prior",
            authoredConfig: { gateway: { port: 18789 } },
          })
        : null;
      const written = await upsertConfigSnapshotAuditRecordAsync({
        ...context,
        configPath,
        rawHash: "written",
        authoredConfig: { gateway: { port: 18790 } },
      });
      expect(written).not.toBeNull();
      await restoreConfigSnapshotAuditRecordAsync({
        ...context,
        snapshot: prior,
        expectedSnapshot: written,
      });
      expect(await readLatestConfigSnapshotAuditRecordAsync(context)).toEqual(prior);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it("falls back to a redaction marker when the fingerprint key cannot be stored", async () => {
    const home = await suiteRootTracker.make("fingerprint-fallback");
    const statePath = path.join(home, "state-file");
    await fsPromises.writeFile(statePath, "not a directory", "utf-8");

    expect(
      fingerprintConfigSnapshotAuthoredConfig(
        { gateway: { auth: { token: "test-token" } } },
        { env: { OPENCLAW_STATE_DIR: statePath } as NodeJS.ProcessEnv, homedir: () => home },
      ),
    ).toEqual({ gateway: { auth: { token: "***" } } });
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });
});
