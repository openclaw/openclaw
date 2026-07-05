// Covers gateway restart handoff persistence and diagnostics.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
<<<<<<< HEAD
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
  formatGatewayRestartHandoffDiagnostic,
=======
import {
  consumeGatewayRestartHandoffForExitedProcessSync,
  formatGatewayRestartHandoffDiagnostic,
  GATEWAY_SUPERVISOR_RESTART_HANDOFF_FILENAME,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
  readGatewayRestartHandoffSync,
  writeGatewayRestartHandoffSync,
} from "./restart-handoff.js";
import type { GatewayRestartHandoff } from "./restart-handoff.js";

const tempDirs: string[] = [];
<<<<<<< HEAD
type GatewayRestartHandoffDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_handoff">;
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

function createHandoffEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-handoff-"));
  tempDirs.push(dir);
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
  };
}

<<<<<<< HEAD
function legacyHandoffPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.OPENCLAW_STATE_DIR ?? "", "gateway-supervisor-restart-handoff.json");
}

function readHandoffRow(env: NodeJS.ProcessEnv) {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartHandoffDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_handoff")
      .select([
        "handoff_key",
        "kind",
        "version",
        "intent_id",
        "pid",
        "process_instance_id",
        "created_at",
        "expires_at",
        "reason",
        "restart_trace_started_at",
        "restart_trace_last_at",
        "source",
        "restart_kind",
        "supervisor_mode",
      ])
      .where("handoff_key", "=", "current"),
  );
}

function insertHandoffRow(
  env: NodeJS.ProcessEnv,
  values: {
    kind?: string;
    version?: number;
    intentId?: string;
    pid?: number;
    createdAt?: number;
    expiresAt?: number;
    reason?: string | null;
    source?: string;
    restartKind?: string;
    supervisorMode?: string;
    restartTraceStartedAt?: number | null;
    restartTraceLastAt?: number | null;
  },
) {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartHandoffDatabase>(db);
  const now = Date.now();
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("gateway_restart_handoff").values({
      handoff_key: "current",
      kind: values.kind ?? GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
      version: values.version ?? 1,
      intent_id: values.intentId ?? "intent-1",
      pid: values.pid ?? 111,
      process_instance_id: null,
      created_at: values.createdAt ?? 1_000,
      expires_at: values.expiresAt ?? 61_000,
      reason: values.reason ?? null,
      restart_trace_started_at: values.restartTraceStartedAt ?? null,
      restart_trace_last_at: values.restartTraceLastAt ?? null,
      source: values.source ?? "plugin-change",
      restart_kind: values.restartKind ?? "full-process",
      supervisor_mode: values.supervisorMode ?? "external",
      updated_at_ms: now,
    }),
  );
=======
function handoffPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.OPENCLAW_STATE_DIR ?? "", GATEWAY_SUPERVISOR_RESTART_HANDOFF_FILENAME);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

function expectWrittenHandoff(
  opts: Parameters<typeof writeGatewayRestartHandoffSync>[0],
): GatewayRestartHandoff {
  const handoff = writeGatewayRestartHandoffSync(opts);
  if (handoff === null) {
    throw new Error("Expected gateway restart handoff to be written");
  }
  return handoff;
}

describe("gateway restart handoff", () => {
  afterEach(() => {
<<<<<<< HEAD
    closeOpenClawStateDatabaseForTest();
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("writes a supervisor handoff for an exited gateway process", () => {
    const env = createHandoffEnv();

    const handoff = expectWrittenHandoff({
      env,
      pid: 12_345,
      processInstanceId: "gateway-instance-1",
      reason: "plugin source changed",
      restartKind: "full-process",
      supervisorMode: "launchd",
      createdAt: 1_000,
    });

    expect(handoff.kind).toBe(GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND);
    expect(handoff.version).toBe(1);
    expect(handoff.pid).toBe(12_345);
    expect(handoff.processInstanceId).toBe("gateway-instance-1");
    expect(handoff.reason).toBe("plugin source changed");
    expect(handoff.source).toBe("plugin-change");
    expect(handoff.restartKind).toBe("full-process");
    expect(handoff.supervisorMode).toBe("launchd");
    expect(handoff.createdAt).toBe(1_000);
    expect(handoff.expiresAt).toBe(61_000);
<<<<<<< HEAD
    expect(readHandoffRow(env)).toMatchObject({
      handoff_key: "current",
      kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
      pid: 12_345,
      reason: "plugin source changed",
      source: "plugin-change",
      restart_kind: "full-process",
      supervisor_mode: "launchd",
    });
    expect(fs.existsSync(legacyHandoffPath(env))).toBe(false);
=======
    expect(fs.statSync(handoffPath(env)).mode & 0o777).toBe(0o600);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    const persisted = readGatewayRestartHandoffSync(env, 1_500);
    expect(persisted?.pid).toBe(12_345);
    expect(persisted?.reason).toBe("plugin source changed");
  });

  it("persists restart trace timing for supervised process handoff", () => {
    const env = createHandoffEnv();

    const handoff = expectWrittenHandoff({
      env,
      pid: 12_345,
      restartKind: "full-process",
      supervisorMode: "launchd",
      createdAt: 1_000,
      restartTrace: {
        startedAt: 10_000,
        lastAt: 10_250,
      },
    });

    expect(handoff.restartTrace).toStrictEqual({
      startedAt: 10_000,
      lastAt: 10_250,
    });
    expect(readGatewayRestartHandoffSync(env, 1_500)?.restartTrace).toStrictEqual({
      startedAt: 10_000,
      lastAt: 10_250,
    });
  });

  it("keeps restart trace timing for slow but valid drains", () => {
    const env = createHandoffEnv();

    const handoff = expectWrittenHandoff({
      env,
      pid: 12_345,
      restartKind: "full-process",
      supervisorMode: "launchd",
      createdAt: 1_000,
      restartTrace: {
        startedAt: 10_000,
        lastAt: 310_000,
      },
    });

    expect(handoff.restartTrace).toStrictEqual({
      startedAt: 10_000,
      lastAt: 310_000,
    });
    expect(readGatewayRestartHandoffSync(env, 1_500)?.restartTrace).toStrictEqual({
      startedAt: 10_000,
      lastAt: 310_000,
    });
  });

<<<<<<< HEAD
  it("rejects malformed handoff payloads", () => {
    const env = createHandoffEnv();

    insertHandoffRow(env, { intentId: "bad", source: "bad-source" });
=======
  it("consumes a fresh handoff by exited pid instead of current process pid", () => {
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: process.pid + 1,
      reason: "update.run",
      restartKind: "update-process",
      supervisorMode: "systemd",
      createdAt: 2_000,
    });

    const consumed = consumeGatewayRestartHandoffForExitedProcessSync({
      env,
      exitedPid: process.pid + 1,
      now: 2_001,
    });
    expect(consumed?.pid).toBe(process.pid + 1);
    expect(consumed?.source).toBe("gateway-update");
    expect(consumed?.restartKind).toBe("update-process");
    expect(consumed?.supervisorMode).toBe("systemd");
    expect(fs.existsSync(handoffPath(env))).toBe(false);
  });

  it("rejects handoffs for a different exited pid and clears them", () => {
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: 111,
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
    });

    expect(
      consumeGatewayRestartHandoffForExitedProcessSync({
        env,
        exitedPid: 222,
        now: 1_001,
      }),
    ).toBeNull();
    expect(fs.existsSync(handoffPath(env))).toBe(false);
  });

  it("rejects a handoff when the supplied process instance does not match", () => {
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: 111,
      processInstanceId: "gateway-instance-1",
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
    });

    expect(
      consumeGatewayRestartHandoffForExitedProcessSync({
        env,
        exitedPid: 111,
        processInstanceId: "gateway-instance-2",
        now: 1_001,
      }),
    ).toBeNull();
    expect(fs.existsSync(handoffPath(env))).toBe(false);
  });

  it("rejects malformed handoff payloads", () => {
    const env = createHandoffEnv();

    fs.writeFileSync(
      handoffPath(env),
      `${JSON.stringify({
        kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
        version: 1,
        intentId: "bad",
        pid: 111,
        createdAt: 1_000,
        expiresAt: 61_000,
        reason: 123,
        source: "bad-source",
        restartKind: "full-process",
        supervisorMode: "external",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    expect(readGatewayRestartHandoffSync(env, 1_001)).toBeNull();
  });

<<<<<<< HEAD
  it("rejects expired handoff rows", () => {
=======
  it("rejects expired and oversized handoff files", () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: 111,
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
      ttlMs: 1_000,
    });
    expect(readGatewayRestartHandoffSync(env, 2_001)).toBeNull();
<<<<<<< HEAD
=======

    fs.writeFileSync(handoffPath(env), "x".repeat(8192), { encoding: "utf8", mode: 0o600 });
    expect(
      consumeGatewayRestartHandoffForExitedProcessSync({
        env,
        exitedPid: 111,
        now: 2_001,
      }),
    ).toBeNull();
    expect(fs.existsSync(handoffPath(env))).toBe(false);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("rejects persisted handoffs with a ttl longer than the supported window", () => {
    const env = createHandoffEnv();

<<<<<<< HEAD
    insertHandoffRow(env, { intentId: "too-long", createdAt: 1_000, expiresAt: 61_001 });

    expect(readGatewayRestartHandoffSync(env, 1_001)).toBeNull();
  });

  it("overwrites the previous pending handoff row", () => {
    const env = createHandoffEnv();
=======
    fs.writeFileSync(
      handoffPath(env),
      `${JSON.stringify({
        kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
        version: 1,
        intentId: "too-long",
        pid: 111,
        createdAt: 1_000,
        expiresAt: 61_001,
        source: "plugin-change",
        restartKind: "full-process",
        supervisorMode: "external",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    expect(readGatewayRestartHandoffSync(env, 1_001)).toBeNull();
    expect(
      consumeGatewayRestartHandoffForExitedProcessSync({
        env,
        exitedPid: 111,
        now: 1_001,
      }),
    ).toBeNull();
    expect(fs.existsSync(handoffPath(env))).toBe(false);
  });

  it("does not follow an existing handoff-path symlink when writing", () => {
    const env = createHandoffEnv();
    const targetPath = path.join(env.OPENCLAW_STATE_DIR ?? "", "attacker-target.txt");
    fs.writeFileSync(targetPath, "keep", "utf8");
    try {
      fs.symlinkSync(targetPath, handoffPath(env));
    } catch {
      return;
    }
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    expectWrittenHandoff({
      env,
      pid: 12_345,
      restartKind: "full-process",
      supervisorMode: "external",
    });
<<<<<<< HEAD
    expectWrittenHandoff({
      env,
      pid: 67_890,
      reason: "gateway.restart",
      restartKind: "update-process",
      supervisorMode: "systemd",
    });

    expect(readHandoffRow(env)).toMatchObject({
      handoff_key: "current",
      pid: 67_890,
      reason: "gateway.restart",
      source: "operator-restart",
      restart_kind: "update-process",
      supervisor_mode: "systemd",
    });
    expect(readGatewayRestartHandoffSync(env)?.pid).toBe(67_890);
    expect(fs.existsSync(legacyHandoffPath(env))).toBe(false);
=======

    expect(fs.readFileSync(targetPath, "utf8")).toBe("keep");
    expect(fs.lstatSync(handoffPath(env)).isSymbolicLink()).toBe(false);
    expect(
      consumeGatewayRestartHandoffForExitedProcessSync({
        env,
        exitedPid: 12_345,
      })?.pid,
    ).toBe(12_345);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("formats a concise diagnostic line for status surfaces", () => {
    expect(
      formatGatewayRestartHandoffDiagnostic(
        {
          kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
          version: 1,
          intentId: "intent-1",
          pid: 12_345,
          createdAt: 10_000,
          expiresAt: 70_000,
          reason: "plugin source changed",
          source: "plugin-change",
          restartKind: "full-process",
          supervisorMode: "launchd",
        },
        12_500,
      ),
    ).toBe(
      "Recent restart handoff: full-process via launchd; source=plugin-change; reason=plugin source changed; pid=12345; age=2s; expiresIn=57s",
    );
  });

  it("formats restart reasons as a single diagnostic line", () => {
    expect(
      formatGatewayRestartHandoffDiagnostic(
        {
          kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
          version: 1,
          intentId: "intent-1",
          pid: 12_345,
          createdAt: 10_000,
          expiresAt: 70_000,
          reason: "ok\nFake: bad",
          source: "operator-restart",
          restartKind: "full-process",
          supervisorMode: "external",
        },
        12_500,
      ),
    ).toBe(
      "Recent restart handoff: full-process via external; source=operator-restart; reason=ok Fake: bad; pid=12345; age=2s; expiresIn=57s",
    );
  });
});
