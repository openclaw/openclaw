import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { readRestartSentinel, writeRestartSentinel } from "./restart-sentinel.js";
import {
  recoverInterruptedUpdateBeforeGatewayStart,
  resetInterruptedUpdateRecoveryForTests,
} from "./update-interrupted-recovery.js";
import {
  readUpdateRecoveryJournal,
  resolveUpdateRecoveryJournalPathFromSnapshot,
  rewriteUpdateRecoveryJournal,
} from "./update-recovery-journal.js";
import { createUpdateStateSnapshot } from "./update-state-snapshot.js";
import {
  advanceUpdateTransactionMarker,
  markUpdateTransactionConfirmationFailed,
  markUpdateTransactionDeliveryAck,
  markUpdateTransactionProbationReleased,
  writeUpdateTransactionMarker,
} from "./update-transaction-marker.js";

const roots: string[] = [];

afterEach(async () => {
  resetInterruptedUpdateRecoveryForTests();
  vi.useRealTimers();
  closeOpenClawStateDatabase();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("interrupted update recovery", () => {
  it("does not create a state database when no transaction exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-no-marker-"));
    roots.push(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };

    await expect(recoverInterruptedUpdateBeforeGatewayStart(env)).resolves.toBe("continue");
    await expect(fs.access(resolveOpenClawStateSqlitePath(env))).rejects.toThrow();
  });

  it("rejects a newer state schema without mutating it during marker discovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-newer-schema-"));
    roots.push(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    await fs.mkdir(env.OPENCLAW_STATE_DIR, { recursive: true });
    const databasePath = resolveOpenClawStateSqlitePath(env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE gateway_restart_sentinel (
        sentinel_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
    `);
    const payload = {
      kind: "update",
      status: "skipped",
      ts: 1,
      stats: {
        handoffId: "handoff-newer-schema",
        updatePhase: "rolling-back",
        confirmationTier: "delivery",
        confirmationStatus: "failed",
        packageRoot: path.join(root, "package"),
        retainedPackageRoot: path.join(root, "retained"),
        stateSnapshotRoot: path.join(root, "snapshot"),
      },
    };
    database
      .prepare(
        "INSERT INTO gateway_restart_sentinel (sentinel_key, payload_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run("current", JSON.stringify(payload), 1);
    database.close();
    const before = await fs.readFile(databasePath);

    await expect(recoverInterruptedUpdateBeforeGatewayStart(env)).rejects.toThrow(
      "database schema(s) are newer",
    );
    expect(await fs.readFile(databasePath)).toEqual(before);
  });

  it("refuses candidate startup while a rejected confirmation owner lease is live", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-rejected-live-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const snapshotRoot = path.join(root, "snapshot");
    const packageRoot = path.join(root, "openclaw");
    const retainedPackageRoot = path.join(root, ".openclaw-previous");
    await Promise.all([
      fs.mkdir(snapshotRoot, { recursive: true }),
      fs.mkdir(packageRoot),
      fs.mkdir(retainedPackageRoot),
    ]);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await writeUpdateTransactionMarker({
      result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
      meta: { handoffId: "handoff-rejected" },
      confirmationTier: "delivery",
      phase: "healthy",
      rollback: {
        packageRoot,
        retainedPackageRoot,
        stateSnapshotRoot: snapshotRoot,
        nodePath: process.execPath,
      },
      env,
    });
    await markUpdateTransactionConfirmationFailed({
      handoffId: "handoff-rejected",
      reason: "replay admission failed",
      env,
    });

    await expect(recoverInterruptedUpdateBeforeGatewayStart(env)).resolves.toBe("owner-active");
  });

  it("commits a staged journal confirmation already durable in SQLite", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-reconcile-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const snapshotRoot = path.join(root, "snapshot");
    const packageRoot = path.join(root, "openclaw");
    const retainedPackageRoot = path.join(root, ".openclaw-previous");
    await Promise.all([fs.mkdir(packageRoot), fs.mkdir(retainedPackageRoot)]);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await writeUpdateTransactionMarker({
      result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
      meta: { handoffId: "handoff-reconcile" },
      confirmationTier: "delivery",
      phase: "healthy",
      rollback: {
        packageRoot,
        retainedPackageRoot,
        stateSnapshotRoot: snapshotRoot,
        nodePath: process.execPath,
      },
      env,
    });
    const current = (await readRestartSentinel(env))!.payload;
    const stagedConfirmed = {
      ...current,
      stats: {
        ...current.stats,
        updatePhase: "confirm" as const,
        confirmationStatus: "delivery-acked" as const,
        reason: "journal-staged",
      },
    };
    await rewriteUpdateRecoveryJournal({
      filePath: resolveUpdateRecoveryJournalPathFromSnapshot(snapshotRoot),
      handoffId: "handoff-reconcile",
      stageConfirmation: true,
      rewrite: () => stagedConfirmed,
    });
    const confirmed = {
      ...stagedConfirmed,
      stats: { ...stagedConfirmed.stats, reason: "sqlite-confirmed" },
    };
    await writeRestartSentinel(confirmed, env);

    await expect(recoverInterruptedUpdateBeforeGatewayStart(env)).resolves.toBe("continue");
    expect((await readRestartSentinel(env))?.payload.stats?.confirmationStatus).toBe(
      "delivery-acked",
    );
    const journal = await readUpdateRecoveryJournal(
      resolveUpdateRecoveryJournalPathFromSnapshot(snapshotRoot),
    );
    expect(journal.committedPayload.stats?.reason).toBe("sqlite-confirmed");
  });

  it("keeps confirmed gateway startup nonblocking when snapshot cleanup fails", async () => {
    vi.useFakeTimers();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-cleanup-retry-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const snapshotRoot = path.join(root, "corrupt-snapshot");
    const packageRoot = path.join(root, "openclaw");
    const retainedPackageRoot = path.join(root, ".openclaw-previous");
    await Promise.all([
      fs.mkdir(snapshotRoot, { recursive: true }),
      fs.mkdir(packageRoot),
      fs.mkdir(retainedPackageRoot),
    ]);
    await fs.writeFile(path.join(snapshotRoot, "update-state-snapshot.json"), "{}\n");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await writeUpdateTransactionMarker({
      result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
      meta: { handoffId: "handoff-cleanup-retry" },
      confirmationTier: "delivery",
      phase: "restart",
      rollback: {
        packageRoot,
        retainedPackageRoot,
        stateSnapshotRoot: snapshotRoot,
        nodePath: process.execPath,
      },
      env,
    });
    await advanceUpdateTransactionMarker({
      handoffId: "handoff-cleanup-retry",
      phase: "healthy",
      env,
    });
    await markUpdateTransactionDeliveryAck({ handoffId: "handoff-cleanup-retry", env });
    await markUpdateTransactionProbationReleased({ handoffId: "handoff-cleanup-retry", env });
    const leaseExpiresAt = (await readRestartSentinel(env))?.payload.stats
      ?.updateOwnerLeaseExpiresAtMs;

    await expect(
      recoverInterruptedUpdateBeforeGatewayStart(env, leaseExpiresAt! + 1),
    ).resolves.toBe("continue");
    expect(await readRestartSentinel(env)).not.toBeNull();
  });

  it("restores package then state before gateway startup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-recovery-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const packageRoot = path.join(root, "global", "openclaw");
    const retainedPackageRoot = path.join(root, "global", ".openclaw-previous");
    await Promise.all([
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(packageRoot, { recursive: true }),
      fs.mkdir(retainedPackageRoot, { recursive: true }),
    ]);
    await fs.writeFile(path.join(stateDir, "openclaw.json"), '{"before":true}\n');
    await fs.writeFile(path.join(packageRoot, "version.txt"), "new\n");
    await fs.writeFile(path.join(retainedPackageRoot, "version.txt"), "old\n");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "snapshot fixture",
      },
      env,
    );
    closeOpenClawStateDatabase();
    const snapshot = await createUpdateStateSnapshot({
      retainedPackageRoot,
      currentPackageRoot: packageRoot,
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      timeoutMs: 1_000,
      runCommand: async (argv) => {
        await fs.cp(argv.at(-2)!, argv.at(-1)!, { recursive: true });
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    await writeUpdateTransactionMarker({
      result: {
        status: "ok",
        mode: "npm",
        root: packageRoot,
        steps: [],
        durationMs: 1,
      },
      meta: {
        handoffId: "handoff-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
        deliveryContext: { channel: "telegram", to: "chat-1" },
      },
      confirmationTier: "delivery",
      phase: "swap",
      rollback: {
        packageRoot,
        retainedPackageRoot,
        stateSnapshotRoot: snapshot.root,
        nodePath: process.execPath,
      },
      env,
    });
    await fs.writeFile(path.join(stateDir, "openclaw.json"), '{"after":true}\n');

    expect(await recoverInterruptedUpdateBeforeGatewayStart(env)).toBe("owner-active");
    expect(await fs.readFile(path.join(packageRoot, "version.txt"), "utf8")).toBe("new\n");
    const leaseExpiresAt = (await readRestartSentinel(env))?.payload.stats
      ?.updateOwnerLeaseExpiresAtMs;
    expect(typeof leaseExpiresAt).toBe("number");

    await expect(
      recoverInterruptedUpdateBeforeGatewayStart(env, leaseExpiresAt! + 1, {
        acquireExclusiveStateOwnership: async () => {
          throw new Error("gateway already owns state");
        },
      }),
    ).rejects.toThrow("gateway already owns state");
    expect(await fs.readFile(path.join(packageRoot, "version.txt"), "utf8")).toBe("new\n");
    expect(await fs.readFile(path.join(stateDir, "openclaw.json"), "utf8")).toBe(
      '{"after":true}\n',
    );

    expect(await recoverInterruptedUpdateBeforeGatewayStart(env, leaseExpiresAt! + 1)).toBe(
      "rolled-back",
    );
    expect(await fs.readFile(path.join(packageRoot, "version.txt"), "utf8")).toBe("old\n");
    expect(await fs.readFile(path.join(stateDir, "openclaw.json"), "utf8")).toBe(
      '{"before":true}\n',
    );
    expect((await readRestartSentinel(env))?.payload.stats).toMatchObject({
      updatePhase: "rolled-back",
      confirmationStatus: "failed",
    });
  });

  it("clears a confirmed marker without rolling back the package", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-confirmed-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const packageRoot = path.join(root, "global", "openclaw");
    const retainedPackageRoot = path.join(root, "global", ".openclaw-previous");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(retainedPackageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "version.txt"), "new\n");
    await fs.writeFile(path.join(retainedPackageRoot, "version.txt"), "old\n");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await writeUpdateTransactionMarker({
      result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
      meta: { handoffId: "handoff-confirmed" },
      confirmationTier: "delivery",
      phase: "restart",
      rollback: {
        packageRoot,
        retainedPackageRoot,
        stateSnapshotRoot: path.join(root, "missing-snapshot"),
        nodePath: process.execPath,
      },
      env,
    });
    await advanceUpdateTransactionMarker({
      handoffId: "handoff-confirmed",
      phase: "healthy",
      env,
    });
    await markUpdateTransactionDeliveryAck({ handoffId: "handoff-confirmed", env });
    await markUpdateTransactionProbationReleased({ handoffId: "handoff-confirmed", env });

    expect(await recoverInterruptedUpdateBeforeGatewayStart(env)).toBe("continue");
    expect(await fs.readFile(path.join(packageRoot, "version.txt"), "utf8")).toBe("new\n");
    expect(await readRestartSentinel(env)).not.toBeNull();
    const leaseExpiresAt = (await readRestartSentinel(env))?.payload.stats
      ?.updateOwnerLeaseExpiresAtMs;
    expect(typeof leaseExpiresAt).toBe("number");
    await vi.advanceTimersByTimeAsync(leaseExpiresAt! - Date.now() + 10);
    await vi.waitFor(async () => {
      expect(await readRestartSentinel(env)).toBeNull();
    });
  });
});
