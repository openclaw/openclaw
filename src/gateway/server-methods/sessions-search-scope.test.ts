import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test as baseTest, vi } from "vitest";
import type {
  SessionsListParams,
  SessionsSearchResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { runSessionColdStorageMaintenance } from "../../config/sessions/session-cold-storage.js";
import { readSessionTranscriptIndexStatus } from "../../config/sessions/session-transcript-projection-writer.js";
import * as transcriptSearch from "../../config/sessions/session-transcript-search.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  sessionReadHandlers,
  disposeSessionReadContexts,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

function test(name: string, run: () => Promise<void>) {
  baseTest(name, () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      try {
        await run();
      } finally {
        await disposeSessionReadContexts();
      }
    }),
  );
}

function searchContext(email: string, cfg: OpenClawConfig = { agents: { entries: { main: {} } } }) {
  const owner = ensureProfileForEmail(email).id;
  setRuntimeConfigSnapshot(cfg);
  const context = requestContext(cfg);
  const client = identifiedClient(owner);
  const find = (params = {}, asClient = client) =>
    search(context, asClient, { query: "needle", scope: {}, ...params });
  return {
    owner,
    context,
    client,
    find,
    async expectKeys(keys: string[], params = {}, asClient = client) {
      const result = await find(params, asClient);
      expect(result.ok, result.error?.message).toBe(true);
      expect(result.payload).toMatchObject({
        results: keys.map((sessionKey) => ({ sessionKey })),
        sessions: keys.map((key) => ({ key })),
      });
      return result;
    },
    list: (request: SessionsListParams = {}, asClient = client) =>
      listSessions({ context, client: asClient, request }),
  };
}

async function search(
  context: GatewayRequestContext,
  client: GatewayClient,
  params: Record<string, unknown>,
) {
  const releaseForeground = retainSessionListForegroundWork();
  try {
    await initializeSessionReadContext(context);
    const respond = vi.fn<RespondFn>();
    const handler = expectDefined(sessionReadHandlers["sessions.search"], "search handler");
    await handler({
      req: { type: "req", id: "search-scope-test", method: "sessions.search" },
      params,
      context,
      client,
      respond,
      isWebchatConnect: () => false,
    });
    const [ok, payload, error] = expectDefined(respond.mock.calls.at(-1), "search response");
    return { ok, payload: payload as SessionsSearchResult, error };
  } finally {
    releaseForeground();
  }
}

async function seed(
  name: string,
  owner: string,
  extra: Parameters<typeof upsertSessionEntryCore>[1] = {},
  text = "needle",
  agentId = "main",
  storePath?: string,
) {
  const sessionKey = `agent:${agentId}:${name}`;
  const sessionId = `${agentId}-${name}`;
  const scope = { agentId, sessionKey, storePath };
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: Date.now(),
    displayName: name,
    createdActor: { type: "human", source: "profile", id: owner },
    visibility: "shared",
    ...extra,
  });
  if (text) {
    await persistSessionTranscriptTurn(
      { ...scope, sessionId },
      {
        cwd: "/fixture",
        updateMode: "none",
        messages: [{ message: { role: "user", content: text }, now: Date.now() }],
      },
    );
  }
  return sessionKey;
}

const paletteScope = {
  configuredAgentsOnly: true,
  includeGlobal: false,
  includeUnknown: false,
  excludeSubagents: true,
  excludeCron: true,
  excludeSystem: true,
};

function agentConfig(ids: string[]): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(ids.map((id) => [id, {}])),
      defaults: { sessionStore: { agentId: "main" } },
    },
  };
}

test("scope search reaches beyond 200 sessions and four agents with bounded matched snapshots", async () => {
  const agents = ["main", "second", "third", "fourth", "fifth"];
  const fixture = searchContext("search-owner@example.test", agentConfig(agents));
  const owner = fixture.owner;
  // These nonmatching roster rows exercise search scope, not asynchronous mutation admission.
  for (let index = 0; index < 205; index++) {
    const agentId = expectDefined(agents[index % agents.length], "fixture agent");
    const name = `roster-${index}`;
    replaceSessionEntrySync(
      { agentId, sessionKey: `agent:${agentId}:${name}` },
      {
        sessionId: `${agentId}-${name}`,
        updatedAt: Date.now(),
        displayName: name,
        createdActor: { type: "human", source: "profile", id: owner },
        visibility: "shared",
      },
    );
  }
  const key = await seed("old-target", owner, { updatedAt: 1 }, "distant uniqueneedle", "fifth");
  await Promise.all(
    agents.map((agentId) =>
      expect(readSessionTranscriptIndexStatus({ agentId })).resolves.toBe(false),
    ),
  );
  const result = await fixture.expectKeys([key], {
    query: "uniqueneedle",
    limit: 1,
    scope: paletteScope,
  });
  expect(result.payload).not.toHaveProperty("indexing");
  expect(result.payload).not.toHaveProperty("truncated");
});

test("scope authorizes and applies membership before the hit limit, and empty scope never widens", async () => {
  const fixture = searchContext("search-viewer@example.test");
  const owner = fixture.owner;
  const groupedSpawn = {
    spawnedBy: "agent:main:parent",
    category: "Research",
    displayName: "Needle conversation",
  };
  const excluded: Array<[string, string, Parameters<typeof upsertSessionEntryCore>[1]]> = [
    ["hidden", "foreign", { visibility: "draft" }],
    ["system", owner, { createdActor: { type: "system", id: "probe" } }],
    ["cron:job", owner, {}],
    ["subagent:child", owner, {}],
    ["ungrouped-child", owner, { category: " " }],
    ["archived", owner, { archivedAt: 1 }],
    ["incognito-row", owner, { incognito: true }],
  ];
  for (const [name, creator, extra] of excluded) {
    await seed(name, creator, { ...groupedSpawn, ...extra });
  }
  await seed("internal-session-effects:run", owner);
  const visible = await seed(
    "dashboard:visible",
    owner,
    {
      ...groupedSpawn,
      createdVia: "spawn",
      createdActor: { type: "agent", id: "main" },
    },
    `needle ${"context ".repeat(30)}`,
  );
  const metadata = await fixture.list({ ...paletteScope, search: "needle", limit: 1 });
  expect(metadata.sessions.map((row) => row.key)).toEqual([visible]);
  expect(metadata.totalCount).toBe(1);
  const result = await fixture.expectKeys([visible], { limit: 1, scope: paletteScope });
  expect(result.payload).not.toHaveProperty("truncated");
  // Visible dashboard sessions stay discoverable with or without a sidebar group.
  for (const category of [" ", "Research"]) {
    await upsertSessionEntryCore({ agentId: "main", sessionKey: visible }, { category });
    const refreshed = await fixture.find({ scope: paletteScope });
    expect(refreshed.ok, refreshed.error?.message).toBe(true);
    expect(refreshed.payload?.results.map((hit) => hit.sessionKey)).toEqual([visible]);
    const listed = await fixture.list({ ...paletteScope, search: "needle" });
    expect(listed.sessions.map((row) => row.key)).toEqual([visible]);
  }
  await fixture.expectKeys([], {
    scope: { ...paletteScope, search: "no-such-roster-row" },
  });
  await upsertSessionEntryCore({ agentId: "main", sessionKey: visible }, { visibility: "draft" });
  const other = identifiedClient(ensureProfileForEmail("other-search-viewer@example.test").id);
  await fixture.expectKeys([], { scope: paletteScope }, other);
  expect(await fixture.list({ ...paletteScope, search: "needle" }, other)).toMatchObject({
    sessions: [],
    totalCount: 0,
  });
});

test("scope search preserves physical shared-store ownership, agent filters, and bounded hit rows", async () => {
  const stateDir = expectDefined(process.env.OPENCLAW_STATE_DIR, "test state is required");
  const storePath = path.join(stateDir, "shared-search.sqlite");
  const cfg: OpenClawConfig = {
    ...agentConfig(["main", "work_team", "workxteam"]),
    session: { store: storePath },
  };
  const fixture = searchContext("shared-search@example.test", cfg);
  const owner = fixture.owner;
  await seed("physical-owner", owner, {}, "", "main", storePath);
  for (let index = 0; index < 27; index++) {
    await seed(`match-${index}`, owner, {}, "needle", "work_team", storePath);
  }
  await seed("foreign-namespace", owner, {}, "needle", "workxteam", storePath);
  const result = await fixture.find({
    limit: 25,
    scope: { agentId: "work_team" },
  });
  expect(result.ok, result.error?.message).toBe(true);
  expect(result.payload?.results).toHaveLength(25);
  expect(result.payload?.sessions).toHaveLength(25);
  expect(
    result.payload?.results.every((hit) => hit.sessionKey.startsWith("agent:work_team:")),
  ).toBe(true);
  expect(new Set(result.payload?.sessions?.map((row) => row.key))).toEqual(
    new Set(result.payload?.results.map((hit) => hit.sessionKey)),
  );
  expect(result.payload).toHaveProperty("truncated", true);
  expect(result.payload).not.toHaveProperty("indexing");
  const key = "agent:work_team:match-0";
  await fixture.expectKeys([key], { scope: { search: key } });
});

test("scope reports only authorized cold transcripts without restoring them", async () => {
  const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    session: {
      store: storePath,
      maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
    },
  };
  const fixture = searchContext("archive-search@example.test", cfg);
  const owner = fixture.owner;
  for (const [name, creator] of [
    ["visible", owner],
    ["hidden", "foreign"],
  ] as const) {
    const sessionKey = await seed(name, creator, { visibility: "draft" }, "cold needle");
    const target = { agentId: "main", sessionKey };
    await replaceSessionEntry(target, {
      sessionId: `current-${name}`,
      updatedAt: Date.now(),
      visibility: "draft",
      createdActor: { type: "human", source: "profile", id: creator },
    });
    // Replacing the generation clears visibility; apply the current draft policy afterward.
    const current = await upsertSessionEntryCore(target, { visibility: "draft" });
    expect(current?.visibility).toBe("draft");
  }
  runOpenClawAgentWriteTransaction(
    ({ db }) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_windows")
          .set({ updated_at: 1, transcript_updated_at: 1 })
          .where("session_id", "in", ["main-visible", "main-hidden"]),
      ),
    { agentId: "main" },
  );
  await expect(runSessionColdStorageMaintenance({ config: cfg })).resolves.toMatchObject({
    archivedTranscripts: 2,
  });
  const result = await fixture.find();
  expect(result).toMatchObject({
    ok: true,
    payload: { results: [], sessions: [], archivedTranscriptsExcluded: 1 },
  });
  expect(result.payload).not.toHaveProperty("indexing");
  expect(
    await transcriptSearch.searchSessionTranscripts({
      agentId: "main",
      storePath,
      query: "needle",
      sessionKeys: ["agent:main:visible", "agent:main:hidden"],
    }),
  ).toMatchObject({ hits: [], archivedTranscriptsExcluded: 2 });
});

test("scope rechecks sharing after readiness and reports FTS failure instead of empty results", async () => {
  const fixture = searchContext("readiness-search@example.test");
  const context = fixture.context;
  const key = await seed("revoked", "foreign");
  await initializeSessionReadContext(context);
  const projection = expectDefined(getSessionRowProjection(context), "search projection");
  const ensureMaterialized = projection.ensureMaterialized;
  vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
    const target = { agentId: "main", sessionKey: key };
    await replaceSessionEntry(target, {
      sessionId: "replacement-generation",
      updatedAt: Date.now(),
    });
    await upsertSessionEntryCore(target, { visibility: "draft" });
    await ensureMaterialized();
  });
  await fixture.expectKeys([]);
  await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, { visibility: "shared" });
  // Current-node sharing also authorizes its retained pre-reset transcript windows.
  expect(await fixture.find()).toMatchObject({
    ok: true,
    payload: {
      results: [{ sessionKey: key, sessionId: "main-revoked" }],
      sessions: [{ key, sessionId: "replacement-generation" }],
    },
  });
  vi.spyOn(transcriptSearch, "searchSessionTranscripts").mockImplementationOnce(() => {
    throw new Error("FTS query failed");
  });
  expect(await fixture.find()).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", message: "FTS query failed" },
  });
});

test("search discards hits and page metadata when sharing is revoked during its worker read", async () => {
  const fixture = searchContext("worker-search@example.test", {
    agents: { entries: { main: {} } },
    gateway: {
      roles: {
        default: "viewer",
        definitions: {
          viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
        },
      },
    },
  });
  const read = transcriptSearch.searchSessionTranscripts;
  for (const scoped of [true, false]) {
    const key = await seed(`worker-revoked-${scoped}`, "foreign");
    const spy = vi
      .spyOn(transcriptSearch, "searchSessionTranscripts")
      .mockImplementationOnce(async (...args) => {
        const result = await read(...args);
        expect(result.hits).toHaveLength(1);
        await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, { visibility: "draft" });
        return { ...result, indexing: true, truncated: true, archivedTranscriptsExcluded: 7 };
      });
    try {
      const response = await fixture.find(scoped ? {} : { scope: undefined, sessionKeys: [key] });
      expect(response.ok).toBe(true);
      expect(response.payload).toEqual({ results: [], ...(scoped ? { sessions: [] } : {}) });
    } finally {
      spy.mockRestore();
    }
  }
});

test("search prepares the full scope and rechecks visibility while materializing archived hits", async () => {
  const fixture = searchContext("archived-search@example.test");
  const key = await seed("archived-hit", "foreign", { archivedAt: 1 });
  const sibling = await seed("non-hit", fixture.owner, { archivedAt: 1 }, "different text");
  const params = { scope: { archived: "all" } };
  await fixture.expectKeys([key], params);
  const projection = expectDefined(getSessionRowProjection(fixture.context), "search projection");
  const prepare = projection.withPreparedExactRows.bind(projection);
  vi.spyOn(projection, "withPreparedExactRows").mockImplementationOnce(
    (queries, consume, options) =>
      projection.withSelectionPreparation(async () => {
        // A category owner can lose its publication reply while this search is awaiting rows.
        sessionChanges.emit({ sessionKey: sibling, factsInvalidated: "category" });
        const query = { agentId: "main", key: sibling };
        expect(projection.sharingTargetState(query)).toEqual({ status: "pending" });
        return prepare(
          queries,
          (read) => {
            const result = consume(read);
            expect(projection.sharingTargetState(query)).toMatchObject({ status: "ready" });
            return result;
          },
          options,
        );
      }),
  );
  await fixture.expectKeys([key], params);
  vi.spyOn(projection, "withPreparedExactRows").mockImplementationOnce(
    async (queries, consume, options) => {
      await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, { visibility: "draft" });
      return prepare(queries, consume, options);
    },
  );
  await fixture.expectKeys([], params);
});
