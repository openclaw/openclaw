import fs from "node:fs";
import path from "node:path";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

const stateRoot = process.env.OPENCLAW_STATE_DIR!;
const generation = process.argv[2];
if (generation !== "predecessor" && generation !== "successor") {
  throw new Error("unexpected fixture generation");
}
for (const layout of ["default", "shared", "embedded"]) {
  const stateDir = path.join(stateRoot, layout);
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  await runLayout(
    stateDir,
    layout,
    generation === "predecessor" ? generation : layout === "embedded" ? "embedded" : generation,
  );
}

async function runLayout(stateDir: string, layout: string, mode: string) {
  const storePath = layout === "shared" ? path.join(stateDir, "shared.sqlite") : undefined;
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {}, ops: {} } },
    ...(storePath ? { session: { store: storePath } } : {}),
  };
  const kinds = [
    "running",
    "done",
    "live",
    "yielded",
    "queued",
    "recovering",
    "retained-task",
    "registry-queued",
    "registry-recovering",
    "registry-completion",
    "malformed-owner",
    "rebound",
    "ops-running",
    "incognito-control",
  ] as const;
  const key = (kind: string) =>
    "agent:" + (kind === "ops-running" ? "ops" : "main") + ":subagent:" + kind;
  const scope = (kind: string) => ({
    agentId: kind === "ops-running" ? "ops" : "main",
    sessionKey: key(kind),
    storePath,
  });
  const rows = () =>
    Object.fromEntries(kinds.map((kind) => [kind, loadSessionEntryReadOnly(scope(kind))]));
  const durableOwners = () => ({
    runs: openOpenClawStateDatabase()
      .db.prepare("SELECT * FROM subagent_runs ORDER BY run_id")
      .all(),
    tasks: openOpenClawStateDatabase().db.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
  });
  const lock = await acquireGatewayLock({
    allowInTests: true,
    port: 24119,
    ...(mode === "embedded"
      ? { role: "agent-embedded" as const }
      : { listenerMode: "foreground" as const }),
  });
  if (!lock) {
    throw new Error("proof requires actual process ownership");
  }
  try {
    await lock.run(async () => {
      if (mode === "predecessor") {
        for (const kind of kinds) {
          if (kind === "incognito-control") {
            continue;
          }
          const now = Date.now();
          const entry: InternalSessionEntry = {
            sessionId: "predecessor-" + kind,
            lifecycleRevision: "predecessor-" + kind,
            startedAt: now,
            updatedAt: now,
            status: kind === "done" ? "done" : kind === "queued" ? "queued" : "running",
            ...(kind === "done" ? { endedAt: now, runtimeMs: 0 } : {}),
            ...(kind === "recovering"
              ? { abortedLastRun: true, restartRecoveryForceSafeTools: true }
              : {}),
          };
          await upsertSessionEntryCore(scope(kind), entry);
        }
        const registry = new Map<string, SubagentRunRecord>();
        for (const kind of ["registry-queued", "registry-recovering", "registry-completion"]) {
          registry.set(kind, {
            runId: kind,
            childSessionKey: key(kind),
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "retained control",
            cleanup: "keep",
            createdAt: Date.now(),
            generation: 7,
            execution: {
              status:
                kind === "registry-queued"
                  ? "queued"
                  : kind === "registry-recovering"
                    ? "interrupted"
                    : "terminal",
            },
            completion: { required: true },
            delivery: { status: "pending" },
            ...(kind === "registry-recovering"
              ? { terminalOwner: "interrupted-recovery" as const }
              : {}),
          });
        }
        saveSubagentRegistryToSqlite(registry);
        // A malformed retained claim is unresolved ownership, never permission to settle its session.
        openOpenClawStateDatabase()
          .db.prepare(
            "INSERT INTO subagent_runs(run_id,child_session_key,requester_session_key,created_at,payload_json) VALUES(?,?,?,?,?)",
          )
          .run("malformed-owner", key("malformed-owner"), "agent:main:main", Date.now(), "{}");
        upsertTaskWithDeliveryStateToSqlite({
          task: {
            taskId: "retained-task",
            runtime: "subagent",
            requesterSessionKey: "agent:main:main",
            ownerKey: "agent:main:main",
            childSessionKey: key("retained-task"),
            scopeKind: "session",
            task: "retained completion",
            status: "succeeded",
            deliveryStatus: "pending",
            notifyPolicy: "done_only",
            createdAt: Date.now(),
          },
        });
      } else if (mode === "successor" || mode === "embedded") {
        await replaceSessionEntry(scope("incognito-control"), {
          sessionId: "incognito",
          incognito: true,
          status: "running",
          startedAt: Math.floor(performance.timeOrigin) - 100,
          updatedAt: Math.floor(performance.timeOrigin) - 100,
        });
        registerAgentRunContext("live-owner", {
          sessionKey: key("live"),
          sessionId: "predecessor-live",
          projectSessionActive: true,
        });
        registerAgentRunContext("yielded-owner", {
          sessionKey: key("yielded"),
          sessionId: "predecessor-yielded",
          projectSessionActive: false,
        });
        const rebound = loadSessionEntryReadOnly(scope("rebound"))!;
        await upsertSessionEntryCore(scope("rebound"), {
          ...rebound,
          sessionId: "successor-rebound",
          lifecycleRevision: "successor-rebound",
          startedAt: Date.now(),
          updatedAt: Date.now(),
        });
        fs.writeFileSync(
          path.join(stateDir, "before-startup.json"),
          JSON.stringify({ rows: rows(), owners: durableOwners() }),
        );
        await runStartupSessionMigration({
          cfg,
          env: process.env,
          log: { info: console.error, warn: console.error },
        });
      } else {
        throw new Error("unexpected fixture mode");
      }
      fs.writeFileSync(
        path.join(stateDir, mode + ".json"),
        JSON.stringify({ pid: process.pid, rows: rows(), owners: durableOwners() }),
      );
    });
  } finally {
    clearAgentRunContext("live-owner");
    clearAgentRunContext("yielded-owner");
    closeOpenClawAgentDatabasesForTest();
    await lock.release();
    closeOpenClawStateDatabaseForTest();
  }
}
