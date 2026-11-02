import path from "node:path";
import { expect, test } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createTestProjection } from "./session-row-projection.read-fixture.test-support.js";
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
    await seedSessionTranscript({
      agentId,
      sessionId,
      sessionKey,
      storePath,
      messages: [
        { role: "user", content: `Title ${agentId}` },
        { role: "assistant", content: `Reply ${agentId}` },
      ],
    });
  }

  const cfg = { session: { store: storeTemplate }, agents: testState.agentsConfig };
  const backfilled = observeSessionRowBackfill(agentIds.map((agentId) => `agent:${agentId}:main`));
  using projection = await createTestProjection({ cfg });
  const context = {
    getRuntimeConfig: () => cfg,
    ...bindSessionRowProjection({}, () => projection),
  };
  const list = (limit?: number) =>
    directSessionReq<SessionsListResult>(
      "sessions.list",
      { includeDerivedTitles: true, includeLastMessage: true, limit },
      { context },
    );
  const initial = await list(agentIds.length);
  expect(initial.ok).toBe(true);
  expect(initial.payload?.sessions).toHaveLength(agentIds.length);
  await backfilled;
  await projection.ensureMaterialized();
  for (const limit of [undefined, 100]) {
    const result = await list(limit);
    expect(result.ok).toBe(true);
    expect(result.payload?.sessions).toMatchObject(
      agentIds.map((agentId) => ({
        agentId,
        derivedTitle: `Title ${agentId}`,
        lastMessagePreview: `Reply ${agentId}`,
      })),
    );
  }
});

test("sessions.list serves warm rows without reading a malformed raw insertion", async () => {
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
  const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
  using projection = await createTestProjection({ cfg });
  let reads: ReturnType<typeof trackSqliteStatementExecutions<"sessionStore">> | undefined;
  try {
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

    const result = await directSessionReq<SessionsListResult>("sessions.list", LIST_PARAMS, {
      context: { getRuntimeConfig: () => cfg, ...bindSessionRowProjection({}, () => projection) },
    });
    expect(result.ok).toBe(true);
    expect(result.payload?.sessions.map((row) => row.sessionId)).toEqual(["sess-main"]);
    expect(reads.counts.sessionStore).toBe(0);
  } finally {
    reads?.restore();
  }
});
