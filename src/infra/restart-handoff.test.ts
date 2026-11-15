// Covers gateway restart handoff persistence and diagnostics.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  consumeGatewayRestartHandoffSync,
  formatGatewayRestartHandoffDiagnostic,
  readGatewayRestartHandoff,
  readGatewayRestartHandoffSync,
  writeGatewayRestartHandoff,
} from "./restart-handoff.js";
import type { GatewayRestartHandoff } from "./restart-handoff.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const handoffConsumerCleanups: Array<() => Promise<void>> = [];
type GatewayRestartHandoffDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_handoff">;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-restart-handoff-") };
});
const consumeHandoff = (expectedPid = 12_345) => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  return consumeGatewayRestartHandoffSync({ expectedPid });
};

function readHandoffRow() {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartHandoffDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb.selectFrom("gateway_restart_handoff").selectAll().where("handoff_key", "=", "current"),
  );
}

async function corruptHandoffRow(
  values: Partial<GatewayRestartHandoffDatabase["gateway_restart_handoff"]>,
) {
  await expectWrittenHandoff();
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartHandoffDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.updateTable("gateway_restart_handoff").set(values).where("handoff_key", "=", "current"),
  );
}

async function expectWrittenHandoff(
  opts: Partial<Parameters<typeof writeGatewayRestartHandoff>[0]> = {},
): Promise<GatewayRestartHandoff> {
  const handoff = await writeGatewayRestartHandoff({
    pid: 12_345,
    restartKind: "full-process",
    supervisorMode: "external",
    env,
    createdAt: 1_000,
    ...opts,
  });
  if (handoff === null) {
    throw new Error("Expected gateway restart handoff to be written");
  }
  return handoff;
}

function spawnHandoffConsumer(params: {
  env: NodeJS.ProcessEnv;
  expectedPid: number;
  now: number;
  signal: AbortSignal;
}) {
  params.signal.throwIfAborted();
  const moduleUrl = new URL("./restart-handoff.ts", import.meta.url).href;
  const script = `
    const mod = await import(${JSON.stringify(moduleUrl)});
    const start = new Promise((resolve) => process.stdin.once("data", resolve));
    process.stdout.write("ready\\n");
    await start;
    Date.now = () => ${params.now};
    const result = mod.consumeGatewayRestartHandoffSync({
      expectedPid: ${params.expectedPid},
    });
    process.stdout.write(JSON.stringify(result) + "\\n");
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), env: params.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.once("error", (error) => stderr.push(error.message));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout, signal: params.signal });
  const output = lines[Symbol.asyncIterator]();
  handoffConsumerCleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
    lines.close();
  });
  return { child, closed, output, stderr };
}

describe("gateway restart handoff", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(handoffConsumerCleanups.splice(0).map((cleanup) => cleanup()));
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it("does not create shared state when no restart handoff database exists", async () => {
    const databasePath = path.join(env.OPENCLAW_STATE_DIR ?? "", "state", "openclaw.sqlite");

    expect(readGatewayRestartHandoffSync(env)).toBeNull();
    await expect(readGatewayRestartHandoff(env)).resolves.toBeNull();
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("reads committed handoff replacements without main-thread handoff SQL", async () => {
    const sql = observeHostDataSql();
    try {
      for (const [source, options] of [
        [
          "plugin-change",
          {
            pid: 111,
            reason: "plugin source changed",
            supervisorMode: "launchd",
            createdAt: 1_000,
            restartTrace: { startedAt: 900, lastAt: 1_000 },
          },
        ],
        [
          "operator-restart",
          {
            pid: 222,
            reason: "gateway.restart",
            supervisorMode: "systemd",
            restartKind: "update-process",
            createdAt: 1_200,
            restartTrace: { startedAt: 1_100, lastAt: 1_200 },
          },
        ],
      ] as const) {
        const handoff = await expectWrittenHandoff(options);
        const { reason: _reason, ...persisted } = options;
        expect(handoff).toMatchObject({ ...persisted, source });
        await expect(readGatewayRestartHandoff(env, 1_500)).resolves.toStrictEqual(handoff);
      }
      expect(
        sql.queries.filter((query) => /\bfrom\s+"?gateway_restart_handoff\b/iu.test(query)),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it("reads a restart handoff without advancing an older shared schema", async () => {
    const handoff = await expectWrittenHandoff();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const databasePath = path.join(env.OPENCLAW_STATE_DIR ?? "", "state", "openclaw.sqlite");
    const olderVersion = OPENCLAW_STATE_SCHEMA_VERSION - 1;
    const writable = new DatabaseSync(databasePath);
    writable.exec(`
      PRAGMA user_version = ${olderVersion};
      UPDATE schema_meta SET schema_version = ${olderVersion} WHERE meta_key = 'primary';
    `);
    writable.close();

    expect(readGatewayRestartHandoffSync(env, 1_500)).toStrictEqual(handoff);
    await expect(readGatewayRestartHandoff(env, 1_500)).resolves.toStrictEqual(handoff);
    await closeOpenClawStateDatabaseAsync();

    using readOnly = new DatabaseSync(databasePath, { readOnly: true });
    expect(readOnly.prepare("PRAGMA user_version").get()).toEqual({ user_version: olderVersion });
    expect(
      readOnly.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ schema_version: olderVersion });
  });

  it("keeps truncated restart reasons free of lone surrogates", async () => {
    const handoff = await expectWrittenHandoff({
      pid: 1,
      reason: `${"a".repeat(199)}😀tail`,
      createdAt: Date.now(),
    });

    expect(handoff.reason).toHaveLength(199);
    expect(Buffer.from(handoff.reason ?? "").toString()).toBe(handoff.reason);
    expect(readGatewayRestartHandoffSync(env)?.reason).toBe(handoff.reason);
  });

  it("formats a concise, single-line diagnostic", () => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(12_500);
    expect(
      formatGatewayRestartHandoffDiagnostic({
        kind: "gateway-supervisor-restart-handoff",
        version: 1,
        intentId: "intent-1",
        pid: 12_345,
        createdAt: 10_000,
        expiresAt: 70_000,
        reason: "ok\nFake: bad",
        source: "operator-restart",
        restartKind: "full-process",
        supervisorMode: "external",
      }),
    ).toBe(
      "Recent restart handoff: full-process via external; source=operator-restart; reason=ok Fake: bad; pid=12345; age=2s; expiresIn=57s",
    );
  });

  it("keeps persisted intent IDs free of lone surrogates", async () => {
    const expectedIntentId = "a".repeat(119);
    await corruptHandoffRow({
      intent_id: ` ${expectedIntentId}😀tail `,
    });

    const handoff = readGatewayRestartHandoffSync(env, 1_500);

    expect(handoff?.intentId).toBe(expectedIntentId);
    expect(Buffer.from(handoff?.intentId ?? "").toString()).toBe(handoff?.intentId);
  });

  it("canonicalizes fractional timing for slow valid drains before persistence", async () => {
    const handoff = await expectWrittenHandoff({
      restartKind: "update-process",
      supervisorMode: "systemd",
      restartTrace: {
        startedAt: 10_000.9,
        lastAt: 310_000.4,
      },
    });

    expect(handoff.restartTrace).toStrictEqual({ startedAt: 10_000, lastAt: 310_000 });
    expect(readGatewayRestartHandoffSync(env, 1_500)?.restartTrace).toStrictEqual(
      handoff.restartTrace,
    );
    const { db } = openOpenClawStateDatabase({ env });
    expect(
      db
        .prepare(
          `SELECT typeof(restart_trace_started_at) AS start, typeof(restart_trace_last_at) AS last
           FROM gateway_restart_handoff WHERE handoff_key = 'current'`,
        )
        .get(),
    ).toEqual({ start: "integer", last: "integer" });
  });

  it("retains a PID-mismatched handoff for the matching consumer", async () => {
    await expectWrittenHandoff();
    vi.spyOn(Date, "now").mockReturnValue(1_500);

    expect(consumeHandoff(54_321)).toStrictEqual({
      status: "rejected",
      reason: "pid-mismatch",
      handoffPid: 12_345,
    });
    expect(readHandoffRow()?.pid).toBe(12_345);
    expect(consumeHandoff()).toMatchObject({
      status: "accepted",
      handoff: { pid: 12_345 },
    });
  });

  it.each([
    ["expired", { expires_at: 2_000 }, 2_000, { reason: "expired", handoffPid: 12_345 }],
    ["malformed", { source: "invalid-source" }, 1_500, { reason: "invalid" }],
    ["ttl too long", { expires_at: 61_001 }, 1_500, { reason: "invalid" }],
    ["future-dated", { created_at: 2_000, expires_at: 62_000 }, 1_500, { reason: "invalid" }],
  ] as const)("removes a %s handoff after rejecting it", async (name, values, now, expected) => {
    if (name === "malformed" || name === "ttl too long") {
      await corruptHandoffRow(values);
    } else {
      await expectWrittenHandoff({
        createdAt: name === "future-dated" ? 2_000 : 1_000,
        ...(name === "expired" ? { ttlMs: 1_000 } : {}),
      });
    }
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(readGatewayRestartHandoffSync(env, now)).toBeNull();
    expect(consumeHandoff()).toStrictEqual({ status: "rejected", ...expected });
    expect(readHandoffRow()).toBeUndefined();
  });

  it("accepts a handoff exactly once across concurrent consumers", async ({ signal }) => {
    const handoff = await expectWrittenHandoff();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const consumers = [0, 1].map(() =>
      spawnHandoffConsumer({ env, expectedPid: 12_345, now: 1_500, signal }),
    );

    // Source bootstrap belongs to the test budget, not the consume deadline.
    // Release both readers only once their real owner module is loaded.
    await Promise.all(
      consumers.map(async ({ output, stderr }) => {
        const ready = await output.next();
        if (ready.done) {
          throw new Error(`handoff consumer closed before readiness: ${stderr.join("")}`);
        }
        expect(ready.value).toBe("ready");
      }),
    );
    const timeout = setTimeout(() => {
      for (const { child } of consumers) {
        child.kill("SIGKILL");
      }
    }, 10_000);
    try {
      for (const { child } of consumers) {
        child.stdin.end("consume\n");
      }
      const results = await Promise.all(
        consumers.map(async ({ closed, output, stderr }) => {
          const { code, signal: exitSignal } = await closed;
          if (code !== 0) {
            throw new Error(`handoff consumer exited ${exitSignal ?? code}: ${stderr.join("")}`);
          }
          const result = await output.next();
          if (result.done) {
            throw new Error("handoff consumer closed without a result");
          }
          return JSON.parse(result.value) as unknown;
        }),
      );
      expect(results).toEqual(
        expect.arrayContaining([
          { status: "accepted", handoff },
          { status: "none", reason: "missing" },
        ]),
      );
      expect(readHandoffRow()).toBeUndefined();
    } finally {
      clearTimeout(timeout);
    }
  });

  it("samples the default time after beginning the write transaction", async () => {
    await expectWrittenHandoff({ ttlMs: 1_000 });
    const { db } = openOpenClawStateDatabase({ env });
    const originalExec = db.exec.bind(db);
    let transactionBegan = false;
    const execSpy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN IMMEDIATE") {
        transactionBegan = true;
      }
      return originalExec(sql);
    });
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (transactionBegan ? 2_000 : 1_500));

    try {
      expect(consumeHandoff()).toStrictEqual({
        status: "rejected",
        reason: "expired",
        handoffPid: 12_345,
      });
    } finally {
      nowSpy.mockRestore();
      execSpy.mockRestore();
    }

    expect(readHandoffRow()).toBeUndefined();
  });
});
