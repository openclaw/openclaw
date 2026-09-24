// Covers gateway restart intent persistence and consumption.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  clearGatewayRestartIntentSync,
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewayRestartIntentSync,
  writeGatewayRestartIntentSync,
} from "./restart-intent.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./sqlite-coordinator.js";
import { acquireGatewayLifecycleCoordinator } from "./state-database-coordinator.js";

const tempDirs: string[] = [];
type GatewayRestartIntentDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_intent">;

function createIntentEnv(initialize = true): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-intent-"));
  tempDirs.push(dir);
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
  };
  if (initialize) {
    openOpenClawStateDatabase({ env });
  }
  return env;
}

function legacyIntentPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.OPENCLAW_STATE_DIR ?? "", "gateway-restart-intent.json");
}

function readIntentRow(env: NodeJS.ProcessEnv) {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_intent")
      .select(["intent_key", "kind", "pid", "created_at", "reason", "force", "wait_ms"])
      .where("intent_key", "=", "gateway-restart"),
  );
}

function insertIntentRow(
  env: NodeJS.ProcessEnv,
  values: {
    kind?: string;
    pid?: number;
    createdAt?: number;
    reason?: string | null;
    force?: number | null;
    waitMs?: number | null;
  },
) {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
  const now = Date.now();
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("gateway_restart_intent").values({
      intent_key: "gateway-restart",
      kind: values.kind ?? "gateway-restart",
      pid: values.pid ?? process.pid,
      created_at: values.createdAt ?? now,
      reason: values.reason ?? null,
      force: values.force ?? null,
      wait_ms: values.waitMs ?? null,
      updated_at_ms: now,
    }),
  );
}

describe("gateway restart intent", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("consumes a fresh intent for the current process", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(true);

    expect(consumeGatewayRestartIntentSync(env)).toBe(true);
    expect(readIntentRow(env)).toBeUndefined();
    expect(fs.existsSync(legacyIntentPath(env))).toBe(false);
  });

  it("records restart options while an older Gateway owns a pending-migration database", () => {
    const env = createIntentEnv();
    const database = openOpenClawStateDatabase({ env });
    const filename = database.path;
    closeOpenClawStateDatabaseForTest();
    const db = new DatabaseSync(filename);
    // The restart table is unchanged across this schema boundary.
    db.exec("PRAGMA user_version=15; UPDATE schema_meta SET schema_version=15");
    const before = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    const anchor = acquireGatewayLifecycleCoordinator({ databasePath: filename });
    anchor.release();
    // An independent connection models the running Gateway's non-reentrant lease.
    const owner = tryAcquireExclusiveSqliteCoordinator(anchor.path);
    if (!owner) {
      db.close();
      throw new Error("Fixture Gateway lifecycle lease unavailable");
    }
    try {
      expect(
        writeGatewayRestartIntentSync({
          env,
          targetPid: process.pid,
          intent: { reason: "gateway.restart", force: true, waitMs: 12_345 },
        }),
      ).toBe(true);
      expect(
        db.prepare("SELECT pid, reason, force, wait_ms FROM gateway_restart_intent").get(),
      ).toEqual({
        pid: process.pid,
        reason: "gateway.restart",
        force: 1,
        wait_ms: 12_345,
      });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
      expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 15,
      });
      expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
      clearGatewayRestartIntentSync(env);
      expect(db.prepare("SELECT * FROM gateway_restart_intent").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
    } finally {
      owner.release();
      db.close();
    }
  });

  it("skips intent recording instead of bootstrapping missing Gateway state", () => {
    const env = createIntentEnv(false);
    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(false);
    expect(fs.readdirSync(env.OPENCLAW_STATE_DIR ?? "")).toEqual([]);
  });

  it("rejects an intent for a different process", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid + 1 })).toBe(true);

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(readIntentRow(env)).toBeUndefined();
    expect(fs.existsSync(legacyIntentPath(env))).toBe(false);
  });

  it("rejects expired intents before restart", () => {
    const env = createIntentEnv();
    insertIntentRow(env, { createdAt: Date.now() - 120_000 });

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(readIntentRow(env)).toBeUndefined();
  });

  it("drops malformed intent rows before restart", () => {
    const env = createIntentEnv();
    insertIntentRow(env, { kind: "bad-intent" });

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(readIntentRow(env)).toBeUndefined();
  });

  it("round-trips restart options without persisting process-local successor identity", () => {
    const env = createIntentEnv();

    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid,
        reason: "gateway.restart",
        intent: {
          force: true,
          waitMs: 12_345,
          successorOwner: {
            kind: "managed-update-handoff",
            handoffId: "private-handoff",
            installRoot: "/private/install",
          },
        },
      }),
    ).toBe(true);

    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({
      reason: "gateway.restart",
      force: true,
      waitMs: 12_345,
    });
    expect(readIntentRow(env)).toBeUndefined();
    expect(fs.existsSync(legacyIntentPath(env))).toBe(false);
  });

  it("backs off before an emoji that crosses the persisted reason limit", () => {
    const env = createIntentEnv();
    insertIntentRow(env, { reason: "x".repeat(199) + "🧠tail" });

    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({
      reason: "x".repeat(199),
    });
  });

  it("overwrites the previous pending intent row", () => {
    const env = createIntentEnv();
    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid + 1,
        reason: "first",
      }),
    ).toBe(true);
    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid,
        reason: "second",
      }),
    ).toBe(true);

    expect(readIntentRow(env)).toMatchObject({
      intent_key: "gateway-restart",
      kind: "gateway-restart",
      pid: process.pid,
      reason: "second",
    });
    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({ reason: "second" });
  });
});
