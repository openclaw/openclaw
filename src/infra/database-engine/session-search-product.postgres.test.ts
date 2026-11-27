import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AgentToolGatewayRequestCaller } from "../../agents/tools/in-process-gateway.js";
import { createSessionsSearchTool } from "../../agents/tools/sessions-search-tool.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { sessionTranscriptIndexNeedsReconcile } from "../../config/sessions/session-transcript-index.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "../../config/sessions/session-transcript-reconcile.js";
import * as transcriptSearch from "../../config/sessions/session-transcript-search.js";
import type { SessionTranscriptSearchParams } from "../../config/sessions/session-transcript-search.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { sessionReadHandlers } from "../../gateway/server-methods/sessions-read.js";
import { retainSessionListForegroundWork } from "../../gateway/session-projection-work.js";
import { appendSessionTranscriptMessagesByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `sessionsearch_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const directories = createTempDirTracker();

describe.skipIf(!connection)("PostgreSQL session search product flow", () => {
  let root: string;
  let suiteEnv: NodeJS.ProcessEnv;
  let viewer: string;
  const client = new pg.Client({ connectionString: connection });
  const scope = (name: string, agentId = "main") => ({
    agentId,
    env: suiteEnv,
    sessionId: name,
    sessionKey: `agent:${agentId}:${name}`,
    storePath: path.join(root, "shared", "shared.sqlite"),
  });
  const search = (query: string, options: Partial<SessionTranscriptSearchParams> = {}) => {
    const { agentId, env, storePath } = scope("selected");
    return transcriptSearch.searchSessionTranscripts({
      agentId,
      env,
      storePath,
      query,
      ...options,
    });
  };
  const hitIds = async (query: string, options: Partial<SessionTranscriptSearchParams> = {}) =>
    (await search(query, options)).hits.map((hit) => hit.messageId);
  const append = async (
    name: string,
    id: string,
    text: string,
    role: "user" | "assistant" = "user",
    agentId = "main",
  ) => {
    const target = scope(name, agentId);
    await upsertSessionEntryCore(target, { sessionId: name, updatedAt: 1 });
    await appendTranscriptMessage(target, {
      eventId: id,
      message: { role, content: text },
    });
  };
  const seedRecall = async (params: {
    agentId: string;
    name: string;
    text: string;
    now: number;
    storePath?: string;
    sessionKey?: string;
    owner?: string;
    spawnedBy?: string;
  }) => {
    const target = {
      agentId: params.agentId,
      env: suiteEnv,
      storePath: params.storePath,
      sessionId: params.name,
      sessionKey: params.sessionKey ?? `agent:${params.agentId}:${params.name}`,
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: params.now,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: params.owner ?? viewer },
      ...(params.spawnedBy ? { spawnedBy: params.spawnedBy, spawnDepth: 1 } : {}),
    });
    await appendTranscriptMessage(target, {
      eventId: `${params.name}-hit`,
      now: params.now,
      message: { role: "user", content: params.text },
    });
    return target;
  };
  const recallTransport = (config: OpenClawConfig) => {
    setRuntimeConfigSnapshot(config);
    const context = requestContext(config);
    const reader = withEngineStoreAdmission(() => identifiedClient(viewer));
    reader.connect.scopes = ["operator.read"];
    const requests: Record<string, unknown>[] = [];
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ) => {
      if (request.method !== "sessions.search" || !isRecord(request.params)) {
        throw new Error("Invalid recall transport request");
      }
      requests.push(request.params);
      const release = retainSessionListForegroundWork();
      try {
        await initializeSessionReadContext(context);
        let result: unknown;
        await sessionReadHandlers["sessions.search"]!({
          req: { type: "req", id: "pg-recall", method: request.method },
          params: request.params,
          context,
          client: reader,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => {
            expect(ok, error?.message).toBe(true);
            result = payload;
          },
        });
        return result as T;
      } finally {
        release();
      }
    };
    return {
      callGateway,
      requests,
      search: (params: Record<string, unknown>) =>
        callGateway<SessionsSearchResult>({ method: "sessions.search", params }),
    };
  };

  afterEach(async () => {
    try {
      await disposeSessionReadContexts();
      await cleanupSessionStateForTest({ stateDir: root });
      directories.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });

  function installFixtureEnvironment() {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  }

  beforeAll(async () => {
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    await client.connect();
  });

  // Each topology owns its registry; duplicate canonical keys cannot span physical stores.
  // Rebind after Vitest restores env stubs so gateway reads share the seeded state owner.
  beforeEach(async () => {
    root = directories.make("session-search-postgres-");
    installFixtureEnvironment();
    suiteEnv = { ...process.env };
    setRuntimeConfigSnapshot({});
    withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: suiteEnv }));
    viewer = withEngineStoreAdmission(
      () => ensureProfileForEmail("postgres-recall@example.test").id,
    );
    const crowded = scope("crowded");
    await upsertSessionEntryCore(crowded, { sessionId: crowded.sessionId, updatedAt: 1 });
    await appendSessionTranscriptMessagesByIdentity({
      ...crowded,
      messages: Array.from({ length: 26 }, (_, index) => ({
        eventId: `crowded-${index}`,
        message: { role: "user", content: "harbor beacon" },
      })),
    });
    await append(
      "selected",
      "selected-hit",
      `harbor beacon ${"context ".repeat(150)}`,
      "assistant",
    );
    await append("foreign", "foreign-hit", "harbor beacon", "assistant", "other");
    await append("phrase", "phrase-hit", "café copper lantern");
    await append("scattered", "scattered-hit", `café copper ${"filler ".repeat(30)}lantern`);
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }
    try {
      await dropPostgresTestSchemas(client, prefix);
    } finally {
      await client.end();
      clearRuntimeConfigSnapshot();
      resetDatabaseEngineSelectionForTest();
      vi.unstubAllEnvs();
    }
  });

  it("applies agent, session and role scope before the result cap", async () => {
    for (const order of ["relevance", "recent"] as const) {
      const selected = await search("harbor beacon", { role: "assistant", limit: 1, order });
      expect(selected.hits.map((hit) => hit.messageId)).toEqual(["selected-hit"]);
      expect(selected.truncated).toBe(false);
      expect(selected.hits[0]!.snippet.length).toBeLessThanOrEqual(500);
      for (const filter of [
        { sessionId: "selected" },
        { sessionKeys: [scope("selected").sessionKey] },
      ]) {
        expect((await search("harbor beacon", { ...filter, limit: 1, order })).hits).toEqual([
          expect.objectContaining({ messageId: "selected-hit" }),
        ]);
      }
    }
    const capped = await search("harbor beacon", { limit: 1000 });
    expect(capped.hits).toHaveLength(25);
    expect(capped.truncated).toBe(true);
    expect(capped.hits.every((hit) => hit.sessionKey.startsWith("agent:main:"))).toBe(true);

    await append("underscore", "underscore-hit", "quay signal", "user", "dev_ops");
    await append("lookalike", "lookalike-hit", "quay signal", "user", "devxops");
    expect(
      (await search("quay signal", { agentId: "dev_ops" })).hits.map((hit) => hit.messageId),
    ).toEqual(["underscore-hit"]);

    const config = {
      agents: { entries: { main: {} } },
      session: { store: scope("selected").storePath },
    };
    setRuntimeConfigSnapshot(config);
    const context = requestContext(config);
    const tool = createSessionsSearchTool({
      config,
      agentId: "main",
      agentSessionKey: scope("selected").sessionKey,
      callGateway: async <T>(request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
        if (request.method !== "sessions.search" || !isRecord(request.params)) {
          throw new Error("Invalid session search transport request");
        }
        let payload: unknown;
        await sessionReadHandlers["sessions.search"]!({
          req: { type: "req", id: "pg-session-search", method: request.method },
          params: request.params,
          context,
          client: null,
          isWebchatConnect: () => false,
          respond: (ok, result, error) => {
            if (!ok) {
              throw new Error(error?.message ?? "Session search failed");
            }
            payload = result;
          },
        });
        return payload as T;
      },
    });
    const result = await tool.execute("pg-session-search", {
      query: "harbor beacon",
      sessionKey: "current",
      limit: 1,
    });
    expect(result.details).toMatchObject({
      results: [
        {
          messageId: "selected-hit",
          sessionKey: scope("selected").sessionKey,
          snippet: expect.stringMatching(/^.{1,301}$/su),
        },
      ],
    });
  });

  it("folds diacritics, completes prefixes, ranks proximity and treats operators literally", async () => {
    const ranked = await search("cafe copper lantern");
    expect(ranked.hits.map((hit) => hit.messageId)).toEqual(["phrase-hit", "scattered-hit"]);
    expect(ranked.hits[0]!.score).toBeGreaterThan(ranked.hits[1]!.score);
    expect((await search("cafe copp", { match: "prefix" })).hits).toHaveLength(2);
    for (const query of ["cafe & copper", "cafe | copper", "cafe ! copper", "cafe ( copper )"]) {
      expect(await hitIds(query)).toEqual(["phrase-hit", "scattered-hit"]);
    }
    expect((await search("& | ! ()")).hits).toEqual([]);
    expect((await search("x".repeat(4096))).hits).toEqual([]);
    expect((await search("x ".repeat(2048).trim())).hits).toEqual([]);
    await append("cjk", "cjk-hit", "明天开会议讨论 cat");
    expect(await hitIds("会议 -")).toEqual(["cjk-hit"]);
    expect(await hitIds("会议 cat -")).toEqual(["cjk-hit"]);
    expect(await hitIds("会议 missing -")).toEqual([]);
  });

  it("snippets the passage holding a punctuation-joined match and keeps its punctuation", async () => {
    await append(
      "filename",
      "filename-hit",
      `Opening notes for the deploy review. ${"Routine context keeps going here. ".repeat(80)}The fix to server.py landed after review.`,
    );
    const { hits } = await search("server.py", { sessionId: "filename" });
    expect(hits.map((hit) => hit.messageId)).toEqual(["filename-hit"]);
    expect(hits[0]!.snippet).toContain("fix to server.py landed");
    expect(hits[0]!.snippet).not.toContain("Opening");
  });

  it("indexes a small replacement before committing the transcript rewrite", async () => {
    const target = scope("replacement");
    await append(target.sessionId, "old-message", `outdated polaris ${"original ".repeat(6_000)}`);
    expect(await hitIds("outdated polaris", { sessionId: target.sessionId })).toEqual([
      "old-message",
    ]);

    withEngineStoreAdmission(() => {
      const resolved = resolveSqliteTranscriptScope(target);
      runOpenClawAgentWriteTransaction((writer) => {
        replaceSqliteTranscriptEventsInTransaction(writer, resolved, [
          {
            type: "message",
            id: "new-message",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: "user", content: "replacement marker" },
          },
        ]);
        // Reconciliation after commit cannot hide a deferred rebuild here.
        expect(sessionTranscriptIndexNeedsReconcile(writer.db, target.sessionId)).toBe(false);
      }, toDatabaseOptions(resolved));
    });
    expect(await hitIds("replacement marker", { sessionId: target.sessionId })).toEqual([
      "new-message",
    ]);
    expect(await hitIds("outdated polaris", { sessionId: target.sessionId })).toEqual([]);
  });

  it("publishes appends, rebuilds the active branch and removes deleted transcripts", async () => {
    const alias = { ...scope("json-alias"), storePath: path.join(root, "shared", "shared.json") };
    await upsertSessionEntryCore(alias, { sessionId: alias.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(alias, {
      eventId: "alias-hit",
      message: { role: "user", content: "aliasmarker" },
    });
    expect(await hitIds("aliasmarker", { storePath: alias.storePath })).toEqual(["alias-hit"]);
    await append("rewrite", "retained", "quartz retained");
    await appendTranscriptMessage(scope("rewrite"), {
      eventId: "removed",
      parentId: "retained",
      message: { role: "assistant", content: "quartz obsolete" },
    });
    expect((await hitIds("quartz")).toSorted()).toEqual(["removed", "retained"]);
    await appendTranscriptEvent(scope("rewrite"), {
      type: "leaf",
      id: "rewind",
      parentId: "removed",
      targetId: "retained",
    });
    expect((await search("obsolete")).hits).toEqual([]);
    const options = {
      agentId: "main",
      path: path.join(root, "shared", "shared.sqlite"),
      env: suiteEnv,
    };
    await waitForSessionTranscriptIndexReconcile(options);
    await reconcileSessionTranscriptIndexes(options);
    expect(await hitIds("quartz")).toEqual(["retained"]);
    await reconcileSessionTranscriptIndexes(options);
    expect(await hitIds("quartz")).toEqual(["retained"]);
    const target = scope("rewrite");
    expect(
      await deleteSessionEntryLifecycle({
        ...target,
        target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      }),
    ).toMatchObject({ deleted: true });
    expect((await search("quartz")).hits).toEqual([]);
  });

  it.each(["recallneedle", "会"])(
    "awaits recall authorization across PostgreSQL pages before limiting %s",
    async (query) => {
      const storePath = path.join(root, query === "会" ? "recall-cjk.sqlite" : "recall-fts.sqlite");
      const config: OpenClawConfig = {
        agents: { entries: { main: {} } },
        session: { store: storePath },
        tools: { sessions: { visibility: "all" } },
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      const text = query === "会" ? "明天下午开会讨论" : "recallneedle";
      const epoch = Date.UTC(2026, 0, 1);
      // Identical text keeps rank equal; newer denied rows fill the tool's first SQL page.
      for (let index = 0; index < 27; index++) {
        await seedRecall({
          agentId: "main",
          name: `denied-${index}`,
          text,
          now: epoch + 100 + index,
          storePath,
          owner: "foreign",
        });
      }
      await seedRecall({ agentId: "main", name: "visible-new", text, now: epoch + 20, storePath });
      await seedRecall({ agentId: "main", name: "visible-old", text, now: epoch + 10, storePath });
      await seedRecall({
        agentId: "main",
        name: "denied-only",
        text: "deniedonly",
        now: epoch,
        storePath,
        owner: "foreign",
      });
      const transport = recallTransport(config);
      const originalSearch = transcriptSearch.searchSessionTranscripts;
      const batches: Array<{ keys: string[]; allowed: boolean[] }> = [];
      vi.spyOn(transcriptSearch, "searchSessionTranscripts").mockImplementation(
        (params, database, filter) =>
          originalSearch(
            params,
            database,
            filter &&
              (async (keys) => {
                const allowed = await filter(keys);
                batches.push({ keys: [...keys], allowed });
                return allowed;
              }),
          ),
      );
      const recall = { requesterAgentId: "main", requesterSessionKey: "agent:main:requester" };
      for (const limit of [2, 1]) {
        batches.length = 0;
        const result = await transport.search({ query, limit, recall });
        expect(result.results.map((hit) => hit.messageId)).toEqual(
          limit === 2 ? ["visible-new-hit", "visible-old-hit"] : ["visible-new-hit"],
        );
        expect(result.results.every((hit) => Number.isFinite(hit.score))).toBe(true);
        if (limit === 2) {
          expect(result).not.toHaveProperty("truncated");
        } else {
          expect(result.truncated).toBe(true);
        }
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.every(({ keys }) => keys.length > 0 && keys.length <= limit + 1)).toBe(true);
        expect(batches[0]!.allowed.every((allowed) => !allowed)).toBe(true);
        expect(
          batches.flatMap(({ keys, allowed }) => keys.filter((_, index) => allowed[index])),
        ).toEqual(["agent:main:visible-new", "agent:main:visible-old"]);
      }
      batches.length = 0;
      const tool = createSessionsSearchTool({
        config,
        agentId: "main",
        agentSessionKey: recall.requesterSessionKey,
        callGateway: transport.callGateway,
      });
      const result = await tool.execute("pg-unscoped-recall", { query, limit: 2 });
      expect(result.details).toMatchObject({
        results: [{ messageId: "visible-new-hit" }, { messageId: "visible-old-hit" }],
      });
      expect(result.details).not.toHaveProperty("truncated");
      expect(transport.requests.at(-1)).toMatchObject({ limit: 25, recall });
      expect(transport.requests.at(-1)).not.toHaveProperty("sessionKeys");
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.every(({ keys }) => keys.length > 0 && keys.length <= 26)).toBe(true);
      expect(batches[0]!.allowed.every((allowed) => !allowed)).toBe(true);
      for (const order of ["relevance", "recent"] as const) {
        for (const match of [undefined, "prefix"] as const) {
          const direct = await search(query, { storePath, limit: 2, order, match });
          expect(direct.hits).toHaveLength(2);
          expect(direct.hits.every((hit) => Number.isFinite(hit.score))).toBe(true);
          if (query === "会") {
            expect(direct.hits.map((hit) => hit.score)).toEqual([0, 0]);
          }
        }
      }
      expect(await transport.search({ query: "deniedonly", limit: 1, recall })).toEqual({
        results: [],
      });
    },
  );

  it("recalls the requester's global transcript from its physical agent store", async () => {
    const config: OpenClawConfig = {
      agents: { entries: { main: {}, work: {} } },
      tools: { sessions: { visibility: "all" } },
    };
    setRuntimeConfigSnapshot(config);
    for (const agentId of ["main", "work"]) {
      await seedRecall({
        agentId,
        name: `${agentId}-global`,
        sessionKey: "global",
        text: "physicalglobal",
        now: Date.UTC(2026, 0, 1),
      });
    }
    const transport = recallTransport(config);
    for (const agentId of ["work", "main"]) {
      const result = await transport.search({
        query: "physicalglobal",
        recall: { requesterAgentId: agentId, requesterSessionKey: `agent:${agentId}:requester` },
      });
      expect(
        result.results.map(({ sessionKey, sessionId, messageId }) => ({
          sessionKey,
          sessionId,
          messageId,
        })),
      ).toEqual([
        {
          sessionKey: "global",
          sessionId: `${agentId}-global`,
          messageId: `${agentId}-global-hit`,
        },
      ]);
      expect(result).not.toHaveProperty("truncated");
    }
  });

  it("preserves shared-store underscore namespaces and same- and cross-agent child visibility", async () => {
    const storePath = path.join(root, "recall-shared.sqlite");
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, dev_ops: {}, devxops: {} },
        defaults: { sessionStore: { agentId: "main" } },
      },
      session: { store: storePath },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    };
    setRuntimeConfigSnapshot(config);
    const seed = (agentId: string, name: string, text: string, now: number, spawnedBy?: string) =>
      seedRecall({ agentId, name, text, now, spawnedBy, storePath });
    await seed("main", "physical-owner", "owner", 1);
    await seed("dev_ops", "requester", "namespaceword", 30);
    await seed("dev_ops", "peer", "namespaceword", 20);
    await seed("devxops", "lookalike", "namespaceword", 40);
    const requesterSessionKey = "agent:dev_ops:requester";
    await seed("dev_ops", "subagent:same", "childword", 30, requesterSessionKey);
    await seed("devxops", "subagent:cross", "childword", 20, requesterSessionKey);
    await seed("dev_ops", "unrelated", "childword", 40);
    await seed("devxops", "unrelated", "childword", 50);
    const transport = recallTransport(config);
    const recall = { requesterAgentId: "dev_ops", requesterSessionKey };
    const namespace = await transport.search({
      query: "namespaceword",
      recall: { ...recall, visibility: "agent" },
    });
    expect(namespace.results.map((hit) => hit.messageId)).toEqual(["requester-hit", "peer-hit"]);
    const children = await transport.search({
      query: "childword",
      recall: {
        ...recall,
        restrictToSpawned: true,
        visibility: "all",
        agentToAgent: { enabled: true },
      },
    });
    expect(children.results.map((hit) => hit.messageId)).toEqual([
      "subagent:same-hit",
      "subagent:cross-hit",
    ]);
    expect(children).not.toHaveProperty("truncated");
  });
});
