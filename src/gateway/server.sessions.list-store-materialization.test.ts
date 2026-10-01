/**
 * Session listing keeps whole-store materialization, sharing refreshes, and
 * transcript projection work bounded at their owning storage boundaries.
 */
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as agentScope from "../agents/agent-scope.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import * as sessionEntryReader from "../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionEntryStatus from "../config/sessions/session-accessor.sqlite-status.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
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

test("sessions.list keeps roster enumeration bounded as ordinary rows grow", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
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
    expect((await directSessionReq("sessions.list", LIST_PARAMS)).ok).toBe(true);
    const roster = vi.spyOn(agentScope, "listAgentIds");
    try {
      const result = await directSessionReq<SessionsListResult>("sessions.list", {
        ...LIST_PARAMS,
        limit: rows + 1,
      });
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
    list: agentIds.map((id, index) => ({ id, default: index === 0 })),
  };

  for (const [index, agentId] of agentIds.entries()) {
    const sessionId = `session-${agentId}`;
    const sessionKey = `agent:${agentId}:main`;
    const storePath = storeTemplate.replace("{agentId}", agentId);
    await writeSessionStore({
      agentId,
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          updatedAt: 1_781_000_000_000 - index,
          displayName: `Title ${agentId}`,
        }),
      },
      storePath,
    });
    await seedSessionTranscript({
      agentId,
      messages: [
        { role: "user", content: `Title ${agentId}` },
        { role: "assistant", content: `Reply ${agentId}` },
      ],
      sessionId,
      sessionKey,
      storePath,
    });
  }

  const cfg = { session: { store: storeTemplate }, agents: testState.agentsConfig };
  const backfilled = observeSessionRowBackfill(agentIds.map((agentId) => `agent:${agentId}:main`));
  const projection = await createSessionRowProjection({ cfg });
  try {
    await backfilled;
    await projection.ensureMaterialized();
    for (const limit of [undefined, 100]) {
      const result = await directSessionReq<SessionsListResult>(
        "sessions.list",
        { includeDerivedTitles: true, includeLastMessage: true, limit },
        {
          context: {
            getRuntimeConfig: () => cfg,
            ...bindSessionRowProjection({}, () => projection),
          },
        },
      );

      expect(result.ok).toBe(true);
      expect(result.payload?.sessions).toHaveLength(agentIds.length);
      expect(
        result.payload?.sessions.map(({ agentId, derivedTitle, lastMessagePreview }) => ({
          agentId,
          derivedTitle,
          lastMessagePreview,
        })),
      ).toEqual(
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
      main: sessionStoreEntry("sess-main"),
    },
  });
  const storePath = testState.sessionStorePath!;
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  const database = openOpenClawAgentDatabase({
    agentId: target.agentId ?? "main",
    path: target.path,
  });
  const stored = database.db
    .prepare("SELECT session_key, entry_json FROM session_nodes LIMIT 1")
    .get() as { session_key: string; entry_json: string };
  const storedEntry = JSON.parse(stored.entry_json) as SessionEntry;
  await sessionAccessor.replaceSessionEntry(
    { agentId: "main", sessionKey: stored.session_key, storePath },
    {
      ...storedEntry,
      skillsSnapshot: { prompt: "large skill prompt", skills: [{ name: "test" }] },
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    },
  );
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("zz-malformed", "malformed", "{", Date.now());

  const fullEntries = sessionAccessor.listSessionEntriesReadOnly({ agentId: "main", storePath });
  expect(fullEntries).toHaveLength(1);
  expect(fullEntries[0]?.entry.skillsSnapshot).toBeDefined();
  expect(fullEntries[0]?.entry.systemPromptReport?.source).toBe("run");

  const readonly = vi.spyOn(sessionEntryReader, "listSessionEntriesReadOnly");
  const decode = vi.spyOn(sessionEntryStatus, "parseSessionEntryJson");
  const cfg = {
    agents: { list: [{ id: "main", default: true }] },
    session: { store: storePath },
  };
  let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
  try {
    projection = await createSessionRowProjection({ cfg });
    expect(readonly.mock.calls[0]?.[0]).toMatchObject({ projection: "list", clone: false });
    expect(readonly.mock.calls.every(([scope]) => scope?.projection === "list")).toBe(true);
    const resident = projection.describe({ agentId: "main", key: stored.session_key });
    expect(resident?.storedEntry?.skillsSnapshot).toBeUndefined();
    expect(resident?.storedEntry?.systemPromptReport).toBeUndefined();
    readonly.mockClear();
    decode.mockClear();

    const result = await directSessionReq<SessionsListResult>("sessions.list", LIST_PARAMS, {
      context: { getRuntimeConfig: () => cfg, ...bindSessionRowProjection({}, () => projection) },
    });
    expect(result.ok).toBe(true);
    expect(result.payload?.sessions.map((row) => row.sessionId)).toEqual(["sess-main"]);
    expect(readonly).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  } finally {
    projection?.dispose();
    readonly.mockRestore();
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
  expect(listEntries).toHaveLength(1);
  expect(listEntries[0]?.entry.skillsSnapshot).toBeUndefined();
  expect(listEntries[0]?.entry.systemPromptReport).toBeUndefined();
});
