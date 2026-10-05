import fs from "node:fs";
import path from "node:path";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
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
    "dashboard-spawned",
    "dashboard-aborted",
    "dashboard-completed-history",
    "dashboard-delivery-before-cleanup",
    "dashboard-retained-wake",
    "dashboard-requester-turn",
    "dashboard-collector-history",
    "dashboard-malformed-descendant",
    "role-spawned",
    "registry-queued",
    "registry-recovering",
    "registry-completion",
    "malformed-owner",
    "rebound",
    "ops-running",
    "incognito-control",
  ] as const;
  const key = (kind: string) =>
    "agent:" +
    (kind === "ops-running" ? "ops" : "main") +
    (kind.startsWith("dashboard-") || kind === "role-spawned" ? ":dashboard:" : ":subagent:") +
    kind;
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
            ...(kind.startsWith("dashboard-") ? { spawnDepth: 1 } : {}),
            ...(kind === "role-spawned" ? { subagentRole: "leaf" as const } : {}),
            ...(kind === "recovering" || kind === "dashboard-aborted"
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
        for (const kind of [
          "dashboard-completed-history",
          "dashboard-delivery-before-cleanup",
          "dashboard-retained-wake",
          "dashboard-requester-turn",
          "dashboard-collector-history",
        ]) {
          for (let index = 0; index < (kind === "dashboard-completed-history" ? 2 : 1); index++) {
            const now = Date.now();
            const runId = `${kind}-child-${index}`;
            const controllerOnly = kind === "dashboard-delivery-before-cleanup";
            registry.set(runId, {
              runId,
              childSessionKey: `agent:main:${index === 0 ? "subagent" : "dashboard"}:${runId}`,
              requesterSessionKey: controllerOnly ? "agent:main:main" : key(kind),
              ...(controllerOnly ? { controllerSessionKey: key(kind) } : {}),
              requesterDisplayKey: "retained history",
              task: "settled child history",
              cleanup: "keep",
              createdAt: now,
              execution: {
                status: "terminal",
                startedAt: now,
                endedAt: now,
                outcome: { status: "ok" },
              },
              completion: { required: true },
              delivery: { status: "delivered", deliveredAt: now },
              ...(kind === "dashboard-delivery-before-cleanup" ? {} : { cleanupCompletedAt: now }),
              ...(kind === "dashboard-retained-wake"
                ? { requesterSettleWake: { status: "pending" as const, attemptCount: 0 } }
                : {}),
              ...(kind === "dashboard-requester-turn"
                ? { requesterTurnRunId: "unfinished-requester" }
                : {}),
              ...(kind === "dashboard-collector-history"
                ? {
                    collect: true,
                    collectorCompletion: { status: "done" as const },
                    collectorLaunchCleanupPending: true,
                  }
                : {}),
            });
          }
        }
        saveSubagentRegistryToSqlite(registry);
        // A malformed retained claim is unresolved ownership, never permission to settle its session.
        openOpenClawStateDatabase()
          .db.prepare(
            "INSERT INTO subagent_runs(run_id,child_session_key,requester_session_key,created_at,payload_json) VALUES(?,?,?,?,?)",
          )
          .run("malformed-owner", key("malformed-owner"), "agent:main:main", Date.now(), "{}");
        openOpenClawStateDatabase()
          .db.prepare(
            "INSERT INTO subagent_runs(run_id,child_session_key,requester_session_key,created_at,payload_json) VALUES(?,?,?,?,?)",
          )
          .run(
            "malformed-descendant",
            "agent:main:subagent:malformed-descendant",
            key("dashboard-malformed-descendant"),
            Date.now(),
            "{}",
          );
      } else if (mode === "successor" || mode === "embedded") {
        if (layout === "default") {
          for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
            subagentRuns.set(runId, entry);
          }
        }
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
    subagentRuns.clear();
    closeOpenClawAgentDatabasesForTest();
    await lock.release();
    closeOpenClawStateDatabaseForTest();
  }
}
