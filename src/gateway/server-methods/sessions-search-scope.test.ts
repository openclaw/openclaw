import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { runSessionColdStorageMaintenance } from "../../config/sessions/session-cold-storage.js";
import * as transcriptSearch from "../../config/sessions/session-transcript-search.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
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

async function search(
  context: GatewayRequestContext,
  client: GatewayClient,
  params: Record<string, unknown>,
) {
  const releaseForeground = retainSessionListForegroundWork();
  try {
    await initializeSessionReadContext(context);
    let response:
      | { ok: boolean; payload?: SessionsSearchResult; error?: { message?: string } }
      | undefined;
    const respond: RespondFn = (ok, payload, error) => {
      response = { ok, payload: payload as SessionsSearchResult, error };
    };
    await expectDefined(
      sessionReadHandlers["sessions.search"],
      "search handler",
    )({
      req: { type: "req", id: "search-scope-test", method: "sessions.search" },
      params,
      context,
      client,
      respond,
      isWebchatConnect: () => false,
    });
    return expectDefined(response, "search response");
  } finally {
    releaseForeground();
  }
}

async function seed(
  agentId: string,
  name: string,
  owner: string,
  text?: string,
  extra: Parameters<typeof upsertSessionEntryCore>[1] = {},
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

test("scope search reaches beyond 200 sessions and four agents with bounded matched snapshots", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    try {
      const owner = ensureProfileForEmail("search-owner@example.test").id;
      const agents = ["main", "second", "third", "fourth", "fifth"];
      const cfg: OpenClawConfig = { agents: { list: agents.map((id) => ({ id })) } };
      for (let index = 0; index < 205; index++) {
        await seed(
          expectDefined(agents[index % agents.length], "fixture agent"),
          `roster-${index}`,
          owner,
        );
      }
      const key = await seed("fifth", "old-target", owner, "distant uniqueneedle", {
        updatedAt: 1,
      });
      const result = await search(requestContext(cfg), identifiedClient(owner), {
        query: "uniqueneedle",
        limit: 1,
        scope: paletteScope,
      });
      expect(result.ok, result.error?.message).toBe(true);
      expect(result.payload).toMatchObject({ results: [{ sessionKey: key }], sessions: [{ key }] });
      expect(result.payload?.results).toHaveLength(1);
      expect(result.payload).not.toHaveProperty("indexing");
      expect(result.payload).not.toHaveProperty("truncated");
    } finally {
      await disposeSessionReadContexts();
    }
  });
});

test("scope authorizes and applies membership before the hit limit, and empty scope never widens", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    try {
      const owner = ensureProfileForEmail("search-viewer@example.test").id;
      const groupedSpawn = {
        spawnedBy: "agent:main:parent",
        category: "Research",
        displayName: "Needle conversation",
      };
      await seed("main", "hidden", "foreign", "needle", {
        ...groupedSpawn,
        visibility: "draft",
      });
      await seed("main", "system", owner, "needle", {
        ...groupedSpawn,
        createdActor: { type: "system", id: "probe" },
      });
      await seed("main", "cron:job", owner, "needle", groupedSpawn);
      await seed("main", "subagent:child", owner, "needle", groupedSpawn);
      await seed("main", "ungrouped-child", owner, "needle", {
        ...groupedSpawn,
        category: " ",
      });
      await seed("main", "archived", owner, "needle", { ...groupedSpawn, archivedAt: 1 });
      await seed("main", "incognito-row", owner, "needle", { ...groupedSpawn, incognito: true });
      await seed("main", "internal-session-effects:run", owner, "needle");
      const visible = await seed(
        "main",
        "dashboard:visible",
        owner,
        `needle ${"context ".repeat(30)}`,
        {
          ...groupedSpawn,
          createdVia: "spawn",
          createdActor: { type: "agent", id: "main" },
        },
      );
      const context = requestContext({ agents: { list: [{ id: "main", default: true }] } });
      const client = identifiedClient(owner);
      const metadata = await listSessions({
        context,
        client,
        request: { ...paletteScope, search: "needle", limit: 1 },
      });
      expect(metadata.sessions.map((row) => row.key)).toEqual([visible]);
      expect(metadata.totalCount).toBe(1);
      const result = await search(context, client, {
        query: "needle",
        limit: 1,
        scope: paletteScope,
      });
      expect(result.ok, result.error?.message).toBe(true);
      expect(result.payload).toMatchObject({
        results: [{ sessionKey: visible }],
        sessions: [{ key: visible }],
      });
      expect(result.payload).not.toHaveProperty("truncated");
      // Visible dashboard sessions stay discoverable with or without a sidebar group.
      for (const [category, expectedKeys] of [
        [" ", [visible]],
        ["Research", [visible]],
      ] as const) {
        await upsertSessionEntryCore({ agentId: "main", sessionKey: visible }, { category });
        const refreshed = await search(context, client, { query: "needle", scope: paletteScope });
        expect(refreshed.ok, refreshed.error?.message).toBe(true);
        expect(refreshed.payload?.results.map((hit) => hit.sessionKey)).toEqual(expectedKeys);
        expect(
          (
            await listSessions({ context, client, request: { ...paletteScope, search: "needle" } })
          ).sessions.map((row) => row.key),
        ).toEqual(expectedKeys);
      }
      const empty = await search(context, client, {
        query: "needle",
        scope: { ...paletteScope, search: "no-such-roster-row" },
      });
      expect(empty).toMatchObject({ ok: true, payload: { results: [], sessions: [] } });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: visible },
        { visibility: "draft" },
      );
      const other = identifiedClient(ensureProfileForEmail("other-search-viewer@example.test").id);
      expect(await search(context, other, { query: "needle", scope: paletteScope })).toMatchObject({
        ok: true,
        payload: { results: [], sessions: [] },
      });
      expect(
        await listSessions({
          context,
          client: other,
          request: { ...paletteScope, search: "needle" },
        }),
      ).toMatchObject({ sessions: [], totalCount: 0 });
    } finally {
      await disposeSessionReadContexts();
    }
  });
});

test("scope search preserves physical shared-store ownership, agent filters, and bounded hit rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    try {
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      if (!stateDir) {
        throw new Error("test state is required");
      }
      const storePath = path.join(stateDir, "shared-search.sqlite");
      const owner = ensureProfileForEmail("shared-search@example.test").id;
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }, { id: "work_team" }, { id: "workxteam" }] },
        session: { store: storePath },
      };
      await seed("main", "physical-owner", owner, undefined, {}, storePath);
      for (let index = 0; index < 27; index++) {
        await seed("work_team", `match-${index}`, owner, "needle", {}, storePath);
      }
      await seed("workxteam", "foreign-namespace", owner, "needle", {}, storePath);
      const context = requestContext(cfg);
      const client = identifiedClient(owner);
      const result = await search(context, client, {
        query: "needle",
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
      expect(
        await search(context, client, { query: "needle", scope: { search: key } }),
      ).toMatchObject({
        ok: true,
        payload: { results: [{ sessionKey: key }], sessions: [{ key }] },
      });
    } finally {
      await disposeSessionReadContexts();
    }
  });
});

test("scope reports only authorized cold transcripts without restoring them", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    try {
      const owner = ensureProfileForEmail("archive-search@example.test").id;
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      for (const [name, creator] of [
        ["visible", owner],
        ["hidden", "foreign"],
      ] as const) {
        const sessionKey = await seed("main", name, creator, "cold needle", {
          visibility: "draft",
        });
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId: `current-${name}`,
            updatedAt: Date.now(),
            visibility: "draft",
            createdActor: { type: "human", source: "profile", id: creator },
          },
        );
        // Replacing the generation clears visibility; apply the current draft policy afterward.
        const current = await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { visibility: "draft" },
        );
        expect(current?.visibility).toBe("draft");
      }
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .updateTable("session_windows")
              .set({ updated_at: 1, transcript_updated_at: 1 })
              .where("session_id", "in", ["main-visible", "main-hidden"]),
          );
        },
        { agentId: "main" },
      );
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main" }] },
        session: {
          store: storePath,
          maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
        },
      };
      await expect(runSessionColdStorageMaintenance({ config: cfg })).resolves.toMatchObject({
        archivedTranscripts: 2,
      });
      const result = await search(requestContext(cfg), identifiedClient(owner), {
        query: "needle",
        scope: {},
      });
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
    } finally {
      await disposeSessionReadContexts();
    }
  });
});

test("scope rechecks sharing after readiness and reports FTS failure instead of empty results", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    try {
      const viewer = ensureProfileForEmail("readiness-search@example.test").id;
      const key = await seed("main", "revoked", "foreign", "needle");
      const context = requestContext({ agents: { list: [{ id: "main", default: true }] } });
      const client = identifiedClient(viewer);
      await initializeSessionReadContext(context);
      const projection = expectDefined(getSessionRowProjection(context), "search projection");
      const ensureMaterialized = projection.ensureMaterialized;
      vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key },
          { sessionId: "replacement-generation", updatedAt: Date.now() },
        );
        await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, { visibility: "draft" });
        await ensureMaterialized();
      });
      expect(await search(context, client, { query: "needle", scope: {} })).toMatchObject({
        ok: true,
        payload: { results: [], sessions: [] },
      });
      await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, { visibility: "shared" });
      // Current-node sharing also authorizes its retained pre-reset transcript windows.
      expect(await search(context, client, { query: "needle", scope: {} })).toMatchObject({
        ok: true,
        payload: {
          results: [{ sessionKey: key, sessionId: "main-revoked" }],
          sessions: [{ key, sessionId: "replacement-generation" }],
        },
      });
      vi.spyOn(transcriptSearch, "searchSessionTranscripts").mockImplementationOnce(() => {
        throw new Error("FTS query failed");
      });
      expect(await search(context, client, { query: "needle", scope: {} })).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "FTS query failed" },
      });
    } finally {
      await disposeSessionReadContexts();
    }
  });
});

test("search discards hits and page metadata when sharing is revoked during its worker read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    try {
      const viewer = ensureProfileForEmail("worker-search@example.test").id;
      const context = requestContext({
        agents: { list: [{ id: "main", default: true }] },
        gateway: {
          roles: {
            default: "viewer",
            definitions: {
              viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        },
      });
      const client = identifiedClient(viewer);
      const read = transcriptSearch.searchSessionTranscripts;
      for (const scoped of [true, false]) {
        const key = await seed("main", `worker-revoked-${scoped}`, "foreign", "needle");
        const spy = vi
          .spyOn(transcriptSearch, "searchSessionTranscripts")
          .mockImplementationOnce(async (...args) => {
            const result = await read(...args);
            expect(result.hits).toHaveLength(1);
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: key },
              { visibility: "draft" },
            );
            return { ...result, indexing: true, truncated: true, archivedTranscriptsExcluded: 7 };
          });
        try {
          const response = await search(context, client, {
            query: "needle",
            ...(scoped ? { scope: {} } : { sessionKeys: [key] }),
          });
          expect(response.ok).toBe(true);
          expect(response.payload).toEqual({ results: [], ...(scoped ? { sessions: [] } : {}) });
        } finally {
          spy.mockRestore();
        }
      }
    } finally {
      await disposeSessionReadContexts();
    }
  });
});
