// Covers safe startup/Doctor import of the retired restart-sentinel JSON file.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  clearRestartSentinelIfRevision,
  readRestartSentinel,
  writeRestartSentinel,
  type RestartSentinelPayload,
} from "./restart-sentinel.js";
import {
  markLegacyMigrationSourceRemoved,
  recordLegacyMigrationReceipt,
} from "./state-migrations.receipts.js";
import {
  detectLegacyRestartSentinel,
  migrateLegacyRestartSentinel,
} from "./state-migrations.restart-sentinel.js";

type MigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "gateway_restart_sentinel" | "migration_sources"
>;

describe("legacy restart sentinel migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-restart-sentinel-migration-");
    return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, stateDir };
  }

  function payload(ts = 123): RestartSentinelPayload {
    return {
      kind: "update",
      status: "ok",
      ts,
      sessionKey: "agent:main:main",
      deliveryContext: { channel: "test", to: "target", accountId: "default" },
      threadId: "thread-1",
      message: "Update completed",
      continuation: { kind: "agentTurn", message: "Continue after restart" },
      doctorHint: "Run Doctor",
      stats: {
        mode: "managed",
        handoffId: "handoff-1",
        requiresRestart: true,
        before: { version: "old" },
        after: { version: "new" },
        steps: [
          {
            name: "install",
            command: "package-manager update",
            durationMs: 10,
            log: { stdoutTail: "done", stderrTail: null, exitCode: 0 },
          },
        ],
      },
    };
  }

  async function writeLegacy(stateDir: string, value: unknown): Promise<string> {
    const sourcePath = path.join(stateDir, "restart-sentinel.json");
    await fsp.writeFile(sourcePath, `${JSON.stringify(value)}\n`, "utf8");
    return sourcePath;
  }

  async function migrate(params: {
    env: NodeJS.ProcessEnv;
    stateDir: string;
    beforeVerify?: () => void;
    removeSource?: (sourcePath: string) => Promise<void> | void;
  }) {
    return await migrateLegacyRestartSentinel({
      detected: detectLegacyRestartSentinel({ stateDir: params.stateDir }),
      ...params,
    });
  }

  function database(env: NodeJS.ProcessEnv) {
    return openOpenClawStateDatabase({ env }).db;
  }

  function receipt(env: NodeJS.ProcessEnv) {
    const db = database(env);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("migration_sources")
        .selectAll()
        .where("migration_kind", "=", "legacy-restart-sentinel-json"),
    );
  }

  it("detects both the retired source and an interrupted fixed claim", async () => {
    const { stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload() });
    expect(detectLegacyRestartSentinel({ stateDir }).hasLegacy).toBe(true);

    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(detectLegacyRestartSentinel({ stateDir }).hasLegacy).toBe(true);
  });

  it.each([false, true])(
    "imports the complete legacy payload after prior native delivery=%s",
    async (priorNative) => {
      const { env, stateDir } = useStateDir();
      if (priorNative) {
        const previous = await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 }, env);
        await clearRestartSentinelIfRevision(previous.revision, env);
      }
      const expected = payload();
      const sourcePath = await writeLegacy(stateDir, { version: 1, payload: expected });

      const result = await migrate({ env, stateDir });

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        "Imported the legacy restart sentinel into shared SQLite state.",
      ]);
      await expect(readRestartSentinel(env)).resolves.toMatchObject({
        version: 1,
        payload: expected,
      });
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(receipt(env)).toMatchObject({
        removed_source: 1,
        source_record_count: 1,
        status: "completed",
        target_table: "gateway_restart_sentinel",
      });
    },
  );

  it("canonicalizes legacy null fields and an empty delivery context before verification", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, {
      version: 1,
      payload: {
        kind: "restart",
        status: "ok",
        ts: 123,
        deliveryContext: {},
        message: null,
        continuation: null,
        doctorHint: null,
        stats: null,
      },
    });

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Imported the legacy restart sentinel into shared SQLite state.",
    ]);
    const migrated = await readRestartSentinel(env);
    expect(migrated?.payload).toEqual({ kind: "restart", status: "ok", ts: 123 });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(receipt(env)).toMatchObject({
      removed_source: 1,
      source_record_count: 1,
      status: "completed",
    });
  });

  it("preserves a valid canonical row when legacy JSON conflicts", async () => {
    const { env, stateDir } = useStateDir();
    const canonical = payload(999);
    await writeRestartSentinel(canonical, env);
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload(1) });

    const result = await migrate({ env, stateDir });

    expect(result.changes).toEqual([
      "Preserved the canonical SQLite restart sentinel and discarded conflicting legacy JSON.",
    ]);
    await expect(readRestartSentinel(env)).resolves.toMatchObject({ payload: canonical });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("repairs an invalid canonical row from a validated legacy envelope", async () => {
    const { env, stateDir } = useStateDir();
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db).insertInto("gateway_restart_sentinel").values({
        sentinel_key: "current",
        version: 99,
        kind: "update",
        status: "ok",
        ts: 1,
        session_key: null,
        thread_id: null,
        delivery_channel: null,
        delivery_to: null,
        delivery_account_id: null,
        message: null,
        continuation_json: null,
        doctor_hint: null,
        stats_json: null,
        payload_json: "{}",
        updated_at_ms: 1,
      }),
    );
    const expected = payload(456);
    await writeLegacy(stateDir, { version: 1, payload: expected });

    const result = await migrate({ env, stateDir });

    expect(result.changes).toEqual([
      "Replaced an invalid SQLite restart sentinel with validated legacy state.",
    ]);
    await expect(readRestartSentinel(env)).resolves.toMatchObject({ payload: expected });
  });

  it("records and removes malformed transient state without disclosing its contents", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, {
      version: 1,
      payload: { ...payload(), ts: "invalid", message: "secret-marker" },
    });

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Discarded malformed retired restart sentinel JSON without importing it.",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-marker");
    expect(receipt(env)?.report_json).not.toContain("secret-marker");
    await expect(readRestartSentinel(env)).resolves.toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports later update generations without replaying any consumed source", async () => {
    const { env, stateDir } = useStateDir();
    await writeLegacy(stateDir, { version: 1, payload: payload(1) });
    await migrate({ env, stateDir });
    const imported = await readRestartSentinel(env);
    if (!imported) {
      throw new Error("Expected the migrated restart sentinel");
    }
    await expect(clearRestartSentinelIfRevision(imported.revision, env)).resolves.toBe(true);
    await writeLegacy(stateDir, { version: 1, payload: payload(2) });
    expect((await migrate({ env, stateDir })).warnings).toEqual([]);
    const later = await readRestartSentinel(env);
    expect(later?.payload).toEqual(payload(2));
    if (!later) {
      throw new Error("Expected the later update notification");
    }
    await clearRestartSentinelIfRevision(later.revision, env);
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload(1) });

    const result = await migrate({ env, stateDir });

    expect(result.changes).toEqual([
      "Discarded recreated retired restart sentinel JSON using its migration receipt.",
    ]);
    await expect(readRestartSentinel(env)).resolves.toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it.each([
    "unchanged",
    "recreated-pending",
    "conflicting-source",
    "newer-canonical",
    "consumed-newer-canonical",
    "consumed-pending",
    "consumed-newer-legacy",
    "published-receipt-without-revision",
    "consumed-published-receipt-without-revision",
    "consumed-newer-canonical-published-receipt-without-revision",
    "consumed-published-replay-receipt",
    "consumed-published-repair-receipt",
    "consumed-published-preserved-receipt",
    "consumed-published-malformed-receipt",
    "consumed-published-malformed-replay-receipt",
    "consumed-published-unknown-receipt",
    "consumed-published-unknown-identical-source",
    "consumed-published-unknown-identical-claim",
  ] as const)(
    "imports a late final only over its own pending revision (%s)",
    async (replacement) => {
      const { env, stateDir } = useStateDir();
      const pending: RestartSentinelPayload = {
        ...payload(1),
        status: "skipped",
        stats: { ...payload(1).stats, reason: "restart-health-pending" },
      };
      const pendingSource = await writeLegacy(stateDir, { version: 1, payload: pending });
      const publishedReceipt = replacement.includes("published-");
      const publishedReplay = replacement.endsWith("replay-receipt");
      const publishedRepair = replacement === "consumed-published-repair-receipt";
      const publishedPreserved = replacement === "consumed-published-preserved-receipt";
      const publishedMalformed = replacement.includes("published-malformed-");
      const unknownReceipt = replacement.startsWith("consumed-published-unknown-");
      const identicalSource = replacement.startsWith("consumed-published-unknown-identical-");
      const interruptedClaim = replacement === "consumed-published-unknown-identical-claim";
      let publishedReportJson: string | undefined;
      if (publishedReceipt) {
        if (publishedMalformed) {
          await fsp.writeFile(pendingSource, "{invalid-json");
        }
        const bytes = await fsp.readFile(pendingSource);
        const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
        const sourceKey = `restart-sentinel-json:${createHash("sha256")
          .update(path.resolve(pendingSource))
          .digest("hex")}`;
        await writeRestartSentinel(pending, env);
        // v2026.9.5 recorded these fields without binding the imported SQLite revision.
        publishedReportJson = JSON.stringify({
          source: "legacy-restart-sentinel-json",
          target: "gateway_restart_sentinel",
          decision: publishedReplay
            ? "receipt-authoritative"
            : unknownReceipt
              ? "unrecognized-decision"
              : publishedPreserved
                ? "canonical-preserved"
                : publishedMalformed
                  ? "malformed-legacy-discarded"
                  : publishedRepair
                    ? "invalid-canonical-repaired"
                    : "legacy-imported",
          sourceSha256,
          sourceValid: !publishedMalformed,
          importedRecordCount: publishedReplay || publishedPreserved || publishedMalformed ? 0 : 1,
          preservedSqliteRecordCount: publishedPreserved ? 1 : 0,
        });
        const reportJson = publishedReportJson;
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            recordLegacyMigrationReceipt(db, {
              sourceKey,
              migrationKind: "legacy-restart-sentinel-json",
              sourcePath: pendingSource,
              targetTable: "gateway_restart_sentinel",
              sourceSha256,
              sourceSizeBytes: bytes.length,
              sourceRecordCount: publishedMalformed ? 0 : 1,
              runId: `${sourceKey}:${sourceSha256.slice(0, 16)}`,
              now: Date.now(),
              reportJson,
            });
          },
          { env },
        );
        await fsp.unlink(pendingSource);
        markLegacyMigrationSourceRemoved(sourceKey, env);
        closeOpenClawStateDatabaseForTest();
      } else {
        await migrate({ env, stateDir });
      }
      let preserved = await readRestartSentinel(env);
      if (replacement === "recreated-pending") {
        await writeLegacy(stateDir, { version: 1, payload: pending });
        await migrate({ env, stateDir });
      } else if (replacement === "conflicting-source") {
        await writeLegacy(stateDir, {
          version: 1,
          payload: { ...payload(2), stats: { handoffId: "unrelated-handoff" } },
        });
        await migrate({ env, stateDir });
      } else if (
        replacement === "newer-canonical" ||
        replacement.startsWith("consumed-newer-canonical")
      ) {
        preserved = await writeRestartSentinel(pending, env);
      }
      if (replacement.startsWith("consumed-")) {
        if (!preserved) {
          throw new Error("Expected the pending update notification");
        }
        await clearRestartSentinelIfRevision(preserved.revision, env);
        if (replacement === "consumed-newer-legacy") {
          await writeLegacy(stateDir, {
            version: 1,
            payload: { ...pending, ts: 2, stats: { ...pending.stats, handoffId: "newer-handoff" } },
          });
          await migrate({ env, stateDir });
          const newer = await readRestartSentinel(env);
          expect(newer?.payload.stats?.handoffId).toBe("newer-handoff");
          if (!newer) {
            throw new Error("Expected the newer legacy update notification");
          }
          await clearRestartSentinelIfRevision(newer.revision, env);
        }
        preserved = null;
      }
      await writeLegacy(stateDir, {
        version: 1,
        payload: identicalSource ? pending : payload(3),
      });
      if (interruptedClaim) {
        await fsp.copyFile(pendingSource, `${pendingSource}.doctor-importing`);
      }
      const sourceBefore = unknownReceipt ? await fsp.readFile(pendingSource) : undefined;

      const result = await migrate({ env, stateDir });

      if (unknownReceipt) {
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("migration receipt is invalid");
      } else {
        expect(result.warnings).toEqual([]);
      }
      const current = await readRestartSentinel(env);
      if (
        replacement === "newer-canonical" ||
        replacement === "published-receipt-without-revision" ||
        replacement.startsWith("consumed-")
      ) {
        expect(current).toEqual(preserved);
      } else {
        expect(current?.payload).toEqual(payload(3));
        expect(current?.revision).not.toBe(preserved?.revision);
      }
      if (publishedReceipt) {
        expect(receipt(env)?.report_json).toBe(publishedReportJson);
        expect(fs.existsSync(pendingSource)).toBe(unknownReceipt);
        if (unknownReceipt) {
          expect(await fsp.readFile(pendingSource)).toEqual(sourceBefore);
        }
        if (interruptedClaim) {
          expect(await fsp.readFile(`${pendingSource}.doctor-importing`)).toEqual(sourceBefore);
        }
      }
    },
  );

  it("admits a later unrelated handoff after preserving native canonical state", async () => {
    const { env, stateDir } = useStateDir();
    const native = await writeRestartSentinel(payload(1), env);
    await writeLegacy(stateDir, { version: 1, payload: payload(2) });
    expect((await migrate({ env, stateDir })).warnings).toEqual([]);
    await expect(readRestartSentinel(env)).resolves.toEqual(native);
    await clearRestartSentinelIfRevision(native.revision, env);
    const next = { ...payload(3), stats: { ...payload(3).stats, handoffId: "next-handoff" } };
    await writeLegacy(stateDir, { version: 1, payload: next });

    expect((await migrate({ env, stateDir })).warnings).toEqual([]);

    await expect(readRestartSentinel(env)).resolves.toMatchObject({ payload: next });
  });

  it("does not use another source generation's receipt to delete an interrupted claim", async () => {
    const { env, stateDir } = useStateDir();
    await writeLegacy(stateDir, { version: 1, payload: payload(1) });
    await migrate({ env, stateDir });
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload(2) });
    const claimPath = `${sourcePath}.doctor-importing`;
    await fsp.rename(sourcePath, claimPath);
    await writeLegacy(stateDir, { version: 1, payload: payload(3) });
    const sourceBefore = await fsp.readFile(sourcePath);
    const claimBefore = await fsp.readFile(claimPath);

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toHaveLength(1);
    expect(await fsp.readFile(sourcePath)).toEqual(sourceBefore);
    expect(await fsp.readFile(claimPath)).toEqual(claimBefore);
  });

  it("recovers an interrupted claim and finishes the same migration owner", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload() });
    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    await expect(readRestartSentinel(env)).resolves.toMatchObject({ payload: payload() });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("preserves changed source bytes and records no receipt", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload(1) });

    const result = await migrate({
      env,
      stateDir,
      beforeVerify: () => {
        fs.writeFileSync(sourcePath, JSON.stringify({ version: 1, payload: payload(2) }));
      },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("changed after migration loaded it");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt(env)).toBeUndefined();
  });

  it("retains a claimed source after cleanup failure and converges on retry", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload() });
    const first = await migrate({
      env,
      stateDir,
      removeSource: () => {
        throw new Error("forced cleanup failure");
      },
    });

    expect(first.warnings).toHaveLength(1);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(receipt(env)).toMatchObject({ removed_source: 0 });

    const second = await migrate({ env, stateDir });
    expect(second.warnings).toEqual([]);
    expect(second.changes).toEqual([
      "Discarded recreated retired restart sentinel JSON using its migration receipt.",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt(env)).toMatchObject({ removed_source: 1 });
  });

  it("requires exclusive state ownership before claiming the retired file", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload() });
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_791,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }
    let result: Awaited<ReturnType<typeof migrateLegacyRestartSentinel>>;
    try {
      result = await migrate({ env, stateDir });
    } finally {
      await gatewayLock.release();
    }

    expect(result.warnings[0]).toContain("OpenClaw state database is busy");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt(env)).toBeUndefined();
  });

  it("rejects symlinks, hardlinks, and oversized sources without deleting them", async () => {
    const cases = ["symlink", "hardlink", "oversized"] as const;
    for (const sourceKind of cases) {
      closeOpenClawStateDatabaseForTest();
      const { env, stateDir } = useStateDir();
      const sourcePath = path.join(stateDir, "restart-sentinel.json");
      if (sourceKind === "oversized") {
        await fsp.writeFile(sourcePath, Buffer.alloc(4 * 1024 * 1024 + 1));
      } else {
        const targetPath = path.join(stateDir, `${sourceKind}-target.json`);
        await fsp.writeFile(targetPath, JSON.stringify({ version: 1, payload: payload() }));
        if (sourceKind === "symlink") {
          await fsp.symlink(targetPath, sourcePath);
        } else {
          await fsp.link(targetPath, sourcePath);
        }
      }

      const result = await migrate({ env, stateDir });

      expect(result.warnings).toHaveLength(1);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(receipt(env)).toBeUndefined();
    }
  });
});
