import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  cleanupSessionStateForTest,
  useSessionStoreTempDirs,
} from "../test-utils/session-state-cleanup.js";
import { migrateHeartbeatOutcomes } from "./doctor-heartbeat-outcome-migration.js";

const roots = useSessionStoreTempDirs(afterEach, "doctor-outcomes-");
afterEach(() => vi.restoreAllMocks());

async function fixture(store: "canonical" | "shared" | "partitioned" = "canonical") {
  const root = roots.make();
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root };
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, ...(store === "shared" ? { ops: {} } : {}) },
    },
    ...(store === "canonical"
      ? {}
      : {
          session: { store: path.join(root, store === "shared" ? "shared.sqlite" : "custom.json") },
        }),
  };
  const now = Date.now();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main", env });
  const scope = { agentId: "main", storePath, env, sessionKey: "agent:main:main" };
  await replaceSessionEntry(scope, {
    sessionId: "original",
    lifecycleRevision: "generation-1",
    updatedAt: now,
    sessionStartedAt: now - 2000,
  });
  const options = toDatabaseOptions(resolveSqliteScope(scope));
  const database = () => openOpenClawAgentDatabase(options).db;
  const row = {
    session_key: scope.sessionKey,
    run_session_key: scope.sessionKey,
    outcome: "progress",
    summary: "The synthetic backup finished.",
    response_reason: null,
    priority: null,
    next_check: null,
    task_names_json: null,
    wake_source: null,
    wake_reason: null,
    occurred_at: now - 1000,
    context_run_id: null,
    context_claimed_at: null,
    updated_at: now,
  };
  const insert = (value: typeof row) =>
    executeSqliteQuerySync(
      database(),
      getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(database())
        .insertInto("heartbeat_outcomes")
        .values(value),
    );
  insert(row);
  const pending = () =>
    executeSqliteQuerySync(
      database(),
      getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(database())
        .selectFrom("heartbeat_outcomes")
        .selectAll(),
    ).rows;
  const update = (values: Partial<typeof row>) =>
    executeSqliteQuerySync(
      database(),
      getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(database())
        .updateTable("heartbeat_outcomes")
        .set(values)
        .where("session_key", "=", scope.sessionKey),
    );
  const events = () => loadTranscriptEventsSync({ ...scope, sessionId: "original" });
  return { cfg, env, scope, row, pending, update, events, now, database, insert };
}

describe("Doctor pending heartbeat context", () => {
  it("imports each logical agent's outcome from one shared physical store", async () => {
    const f = await fixture("shared");
    const ops = { ...f.scope, agentId: "ops", sessionKey: "agent:ops:main" };
    await replaceSessionEntry(ops, {
      sessionId: "ops-session",
      lifecycleRevision: "ops-generation",
      updatedAt: f.now,
      sessionStartedAt: f.now - 2000,
    });
    const opsRow = {
      ...f.row,
      session_key: ops.sessionKey,
      run_session_key: ops.sessionKey,
      summary: "The synthetic ops audit finished.",
    };
    f.insert(opsRow);
    await migrateHeartbeatOutcomes(f.cfg, f.env);
    expect(f.pending()).toEqual([]);
    const mainEvents = f.events();
    const opsEvents = loadTranscriptEventsSync({ ...ops, sessionId: "ops-session" });
    expect(JSON.stringify(mainEvents)).toContain(f.row.summary);
    expect(JSON.stringify(mainEvents)).not.toContain(opsRow.summary);
    expect(JSON.stringify(opsEvents)).toContain(opsRow.summary);
    expect(JSON.stringify(opsEvents)).not.toContain(f.row.summary);
    await migrateHeartbeatOutcomes(f.cfg, f.env);
    expect(f.events()).toEqual(mainEvents);
    expect(loadTranscriptEventsSync({ ...ops, sessionId: "ops-session" })).toEqual(opsEvents);
  });

  it.each(["canonical", "partitioned"] as const)(
    "refuses another logical agent's outcome in a %s per-agent database",
    async (store) => {
      const f = await fixture(store);
      const misplacedKey = "agent:ops:main";
      f.database()
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          misplacedKey,
          "misplaced-session",
          JSON.stringify({ sessionId: "misplaced-session", updatedAt: f.now }),
          f.now,
        );
      f.update({ session_key: misplacedKey, run_session_key: misplacedKey });
      const pending = f.pending();
      const events = f.database().prepare("SELECT * FROM transcript_events").all();
      await expect(migrateHeartbeatOutcomes(f.cfg, f.env)).rejects.toThrow(
        "SQLite session store path belongs to agent main; requested agent ops.",
      );
      expect(f.pending()).toEqual(pending);
      expect(f.database().prepare("SELECT * FROM transcript_events").all()).toEqual(events);
    },
  );

  it("replays an interrupted transfer once and consumes only its original row across reopen", async () => {
    const f = await fixture();
    const append = sessionAccessor.persistSessionTranscriptTurn;
    const crash = vi
      .spyOn(sessionAccessor, "persistSessionTranscriptTurn")
      .mockImplementationOnce(async (...args) => {
        await append(...args);
        throw new Error("interrupted after transcript commit");
      });
    await expect(migrateHeartbeatOutcomes(f.cfg, f.env)).rejects.toThrow(
      "interrupted after transcript commit",
    );
    expect(f.pending()).toEqual([f.row]);
    const committed = f.events();
    expect(JSON.stringify(committed)).toContain(f.row.summary);
    crash.mockRestore();
    await cleanupSessionStateForTest({ stateDir: f.env.OPENCLAW_STATE_DIR });
    await migrateHeartbeatOutcomes(f.cfg, f.env);
    expect(f.pending()).toEqual([]);
    expect(f.events()).toEqual(committed);
    expect(loadSessionEntryReadOnly(f.scope)?.updatedAt).toBe(f.now);
    await migrateHeartbeatOutcomes(f.cfg, f.env);
    expect(f.events()).toEqual(committed);
  });

  it.each(["before-append", "before-commit", "after-append"] as const)(
    "retains a newer source row arriving %s",
    async (when) => {
      const f = await fixture();
      const append = sessionAccessor.persistSessionTranscriptTurn;
      const replaceOutcome = () =>
        f.update({ summary: "Newer authoritative outcome", updated_at: f.now + 1 });
      vi.spyOn(sessionAccessor, "persistSessionTranscriptTurn").mockImplementationOnce(
        async (scope, options) => {
          if (when === "before-append") {
            replaceOutcome();
          }
          const result = await append(scope, {
            ...options,
            ...(when === "before-commit"
              ? {
                  messages: options.messages.map((message) => ({
                    ...message,
                    shouldAppend: () => {
                      replaceOutcome();
                      return true;
                    },
                  })),
                }
              : {}),
          });
          if (when === "after-append") {
            replaceOutcome();
          }
          return result;
        },
      );
      await expect(migrateHeartbeatOutcomes(f.cfg, f.env)).rejects.toThrow(
        "changed during cutover",
      );
      expect(f.pending()).toEqual([
        { ...f.row, summary: "Newer authoritative outcome", updated_at: f.now + 1 },
      ]);
      if (when !== "after-append") {
        expect(JSON.stringify(f.events())).not.toContain(f.row.summary);
      }
    },
  );

  it("does not deliver into a replaced session generation", async () => {
    const f = await fixture();
    const append = sessionAccessor.persistSessionTranscriptTurn;
    vi.spyOn(sessionAccessor, "persistSessionTranscriptTurn").mockImplementationOnce(
      async (...args) => {
        await replaceSessionEntry(f.scope, {
          sessionId: "replacement",
          lifecycleRevision: "generation-2",
          updatedAt: f.now,
        });
        return await append(...args);
      },
    );
    await expect(migrateHeartbeatOutcomes(f.cfg, f.env)).rejects.toThrow("Session changed");
    expect(f.pending()).toEqual([f.row]);
    expect(
      JSON.stringify(loadTranscriptEventsSync({ ...f.scope, sessionId: "replacement" })),
    ).not.toContain(f.row.summary);
  });

  it.each(["before-generation", "expired-session"] as const)(
    "does not promote %s into permanent context",
    async (condition) => {
      const f = await fixture();
      if (condition === "before-generation") {
        f.update({ occurred_at: f.now - 3000 });
      }
      if (condition === "expired-session") {
        f.cfg.session = { reset: { mode: "idle", idleMinutes: 1 } };
        await replaceSessionEntry(f.scope, {
          sessionId: "original",
          updatedAt: f.now - 120000,
          sessionStartedAt: f.now - 120000,
        });
      }
      await migrateHeartbeatOutcomes(f.cfg, f.env);
      expect(JSON.stringify(f.events())).not.toContain(f.row.summary);
      expect(f.pending()).toHaveLength(1);
    },
  );
});
