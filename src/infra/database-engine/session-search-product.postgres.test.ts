import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AgentToolGatewayRequestCaller } from "../../agents/tools/in-process-gateway.js";
import { createSessionsSearchTool } from "../../agents/tools/sessions-search-tool.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "../../config/sessions/session-transcript-reconcile.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import type { SessionTranscriptSearchParams } from "../../config/sessions/session-transcript-search.types.js";
import { requestContext } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { sessionReadHandlers } from "../../gateway/server-methods/sessions-read.js";
import { appendSessionTranscriptMessagesByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `sessionsearch_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const directories = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("PostgreSQL session search product flow", () => {
  let root: string;
  let suiteEnv: NodeJS.ProcessEnv;
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
    return searchSessionTranscripts({ agentId, env, storePath, query, ...options });
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

  beforeAll(async () => {
    root = directories.make("session-search-postgres-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    suiteEnv = { ...process.env };
    setRuntimeConfigSnapshot({});
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    await client.connect();
    withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: suiteEnv }));
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
      await cleanupSessionStateForTest({ stateDir: root });
      const schemas = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
        [prefix.length + 1, `${prefix}_`],
      );
      for (const { nspname } of schemas.rows) {
        await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
      }
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

    vi.stubEnv("OPENCLAW_STATE_DIR", root);
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
    await expect(search(" ")).rejects.toThrow("query must not be empty");
    await expect(search("x".repeat(4097))).rejects.toThrow("query must not exceed 4096");
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
});
