import path from "node:path";
import { expect, test, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as agentScope from "../agents/agent-scope.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import * as sessionEntryStatus from "../config/sessions/session-accessor.sqlite-status.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import * as transcriptWorker from "../config/sessions/session-transcript-worker-runtime.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const EXPECTED_OPEN_HANDLE_CAP = 64;

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

const LIST_PARAMS = {
  agentId: "main",
  configuredAgentsOnly: true,
  includeDerivedTitles: true,
  includeGlobal: true,
  includeUnknown: true,
  limit: 100,
};

test("sessions.list keeps warm roster enumeration bounded as ordinary rows grow", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { entries: { main: {}, work: {} } };
  testState.agentConfig = { sessionStore: { agentId: "main" } };
  const rosterReads: number[] = [];
  for (const rows of [20, 2_001]) {
    const entries: Record<string, ReturnType<typeof sessionStoreEntry>> = {
      main: sessionStoreEntry("sess-main", { updatedAt: 1_781_000_000_001 }),
    };
    for (let index = 0; index < rows; index++) {
      entries[`agent:main:ordinary-${index}`] = sessionStoreEntry(`ordinary-${index}`, {
        updatedAt: 1_781_000_000_000 - index,
      });
    }
    await writeSessionStore({ entries });
    const request = { ...LIST_PARAMS, limit: rows + 1 };
    expect((await directSessionReq("sessions.list", request)).ok).toBe(true);
    const roster = vi.spyOn(agentScope, "listAgentIds");
    try {
      const result = await directSessionReq<SessionsListResult>("sessions.list", request);
      expect(result.ok).toBe(true);
      expect(result.payload?.totalCount).toBe(rows + 1);
      expect(result.payload?.sessions.map(({ key }) => key)).toEqual([
        "agent:main:main",
        ...Array.from({ length: rows }, (_, index) => `agent:main:ordinary-${index}`),
      ]);
      rosterReads.push(roster.mock.calls.length);
    } finally {
      roster.mockRestore();
    }
  }
  expect(rosterReads[1]).toBeLessThanOrEqual(rosterReads[0]!);
});

test("sessions.list retains stored titles and transcript previews beyond the database handle cap", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const agentIds = Array.from(
    { length: EXPECTED_OPEN_HANDLE_CAP + 1 },
    (_, index) => `batch-agent-${index}`,
  );
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  testState.sessionConfig = { store: storeTemplate };
  testState.agentsConfig = {
    entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
  };

  for (const [index, agentId] of agentIds.entries()) {
    const sessionId = `session-${agentId}`;
    const sessionKey = `agent:${agentId}:main`;
    const storePath = storeTemplate.replace("{agentId}", agentId);
    const entry = sessionStoreEntry(sessionId, {
      updatedAt: 1_781_000_000_000 - index,
      displayName: `Title ${agentId}`,
    });
    if (index === 0) {
      // Publish fixture config once; the remaining stores only need pristine row seeding.
      await writeSessionStore({ agentId, entries: { [sessionKey]: entry }, storePath });
    } else {
      sessionAccessor.replaceSessionEntrySync({ agentId, sessionKey, storePath }, entry);
    }
    await replaceTranscriptEvents({ agentId, sessionId, sessionKey, storePath }, [
      { type: "session", version: 3, id: sessionId, cwd: "/tmp" },
      ...(["user", "assistant"] as const).map((role, turn) => ({
        type: "message" as const,
        id: turn ? "reply" : "question",
        parentId: turn ? "question" : null,
        timestamp: `2026-06-19T12:00:0${turn + 1}.000Z`,
        message: { role, content: `${turn ? "Reply" : "Title"} ${agentId}`, timestamp: turn + 1 },
      })),
    ]);
  }

  const cfg = { session: { store: storeTemplate }, agents: testState.agentsConfig };
  const backfilled = observeSessionRowBackfill(agentIds.map((agentId) => `agent:${agentId}:main`));
  const projection = await createSessionRowProjection({ cfg });
  const context = {
    getRuntimeConfig: () => cfg,
    ...bindSessionRowProjection({}, () => projection),
  };
  try {
    const initial = await directSessionReq<SessionsListResult>(
      "sessions.list",
      { includeDerivedTitles: true, includeLastMessage: true, limit: agentIds.length },
      { context },
    );
    expect(initial.ok).toBe(true);
    expect(initial.payload?.sessions).toHaveLength(agentIds.length);
    await backfilled;
    await projection.ensureMaterialized();
    for (const limit of [undefined, 100]) {
      const result = await directSessionReq<SessionsListResult>(
        "sessions.list",
        { includeDerivedTitles: true, includeLastMessage: true, limit },
        { context },
      );

      expect(result.ok).toBe(true);
      expect(result.payload?.sessions).toMatchObject(
        agentIds.map((agentId) => ({
          agentId,
          derivedTitle: `Title ${agentId}`,
          lastMessagePreview: `Reply ${agentId}`,
        })),
      );
    }
  } finally {
    projection.dispose();
  }
});

test("sessions.list projects out prompt snapshots without changing full entry reads", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        skillsSnapshot: { prompt: "large skill prompt", skills: [{ name: "test" }] },
        systemPromptReport: {
          source: "run",
          generatedAt: Date.now(),
          systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      }),
    },
  });
  const storePath = testState.sessionStorePath!;
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  const database = openOpenClawAgentDatabase({
    agentId: target.agentId ?? "main",
    path: target.path,
  });
  const fullEntries = sessionAccessor.listSessionEntriesReadOnly({ agentId: "main", storePath });
  expect(fullEntries).toHaveLength(1);
  expect(fullEntries[0]?.entry.skillsSnapshot).toBeDefined();
  expect(fullEntries[0]?.entry.systemPromptReport?.source).toBe("run");

  const decode = vi.spyOn(sessionEntryStatus, "parseSessionEntryJson");
  const projectionReads = vi.fn();
  const readDatabases = transcriptWorker.withSessionHistoryWorkerDatabases;
  const workerReads = vi
    .spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases")
    .mockImplementation((targets, consume, lane) =>
      readDatabases(
        targets,
        (owners) =>
          consume(
            owners.map((owner) => ({
              ...owner,
              readStoreProjection: (input: Parameters<typeof owner.readStoreProjection>[0]) => {
                projectionReads();
                return owner.readStoreProjection(input);
              },
            })),
          ),
        lane,
      ),
    );
  const cfg = {
    agents: { entries: { main: {} } },
    session: { store: storePath },
  };
  let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
  let reads: ReturnType<typeof trackSqliteStatementExecutions<"sessionStore">> | undefined;
  try {
    projection = await createSessionRowProjection({ cfg });
    expect(projectionReads).toHaveBeenCalled();
    projectionReads.mockClear();
    const resident = projection.describe({ agentId: "main", key: fullEntries[0]!.sessionKey });
    expect(resident?.storedEntry?.sessionId).toBe("sess-main");
    expect(resident?.storedEntry?.skillsSnapshot).toBeUndefined();
    expect(resident?.storedEntry?.systemPromptReport).toBeUndefined();

    // Warm readers tolerate malformed raw edits; new readers must refuse them during admission.
    await withOpenClawAgentDatabaseWrite(
      { agentId: database.agentId, path: database.path },
      (current) => {
        current.db
          .prepare(
            "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run("agent:main:zz-malformed", "malformed", "{", Date.now());
      },
      requireNativeSqliteDatabase(database.db),
    );
    reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["sessionStore"],
      () => "sessionStore",
    );
    decode.mockClear();

    const result = await directSessionReq<SessionsListResult>("sessions.list", LIST_PARAMS, {
      context: { getRuntimeConfig: () => cfg, ...bindSessionRowProjection({}, () => projection) },
    });
    expect(result.ok).toBe(true);
    expect(result.payload?.sessions.map((row) => row.sessionId)).toEqual(["sess-main"]);
    expect(reads.counts.sessionStore).toBe(0);
    expect(projectionReads).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  } finally {
    reads?.restore();
    projection?.dispose();
    workerReads.mockRestore();
    decode.mockRestore();
  }

  expect(sessionAccessor.listSessionEntriesReadOnly({ agentId: "main", storePath })).toEqual(
    fullEntries,
  );

  const listEntries = sessionAccessor.listSessionEntriesReadOnly({
    agentId: "main",
    projection: "list",
    storePath,
  });
  expect(listEntries.map(({ entry }) => [entry.skillsSnapshot, entry.systemPromptReport])).toEqual([
    [undefined, undefined],
  ]);
});
