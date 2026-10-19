import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { waitForGatewayDispatch } from "../../gateway/server-in-process-dispatch.js";
import { GatewayTransportError } from "../../gateway/transport-error.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import { normalizeToolParameters } from "../agent-tools.schema.js";
import { describeSessionLinkRule } from "../tool-description-presets.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createSessionChannelReadFixture } from "./sessions-channel-read-result.test-support.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];
const SESSION_LINK_BASE = "http://127.0.0.1:18789/control";
const SESSION_LINK_RULE = describeSessionLinkRule(SESSION_LINK_BASE);
const MAIN = "agent:main:main";
const WORK = "agent:work:other";
function fixtureConfig(
  visibility: "self" | "agent" | "all",
  agents = ["main"],
  agentToAgent?: boolean,
): OpenClawConfig {
  return {
    tools: {
      sessions: { visibility },
      ...(agentToAgent === undefined ? {} : { agentToAgent: { enabled: agentToAgent } }),
    },
    agents: { entries: Object.fromEntries(agents.map((id) => [id, {}])) },
  };
}
const search = (
  tool: ReturnType<typeof createSessionsSearchTool>,
  params: Record<string, unknown> = {},
) => tool.execute("search", { query: "text", ...params });

function hit(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "main",
    sessionId: "session-main",
    messageId: "message-1",
    role: "assistant",
    timestamp: 123,
    snippet: "matching text",
    score: 1,
    ...overrides,
  };
}

function createTool(params: {
  results?: Array<Record<string, unknown>>;
  config?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  requests?: CallGatewayRequest[];
  sessionLinkBase?: string;
  indexing?: boolean;
  archivedTranscriptsExcluded?: number;
  truncated?: boolean;
}) {
  const config = params.config ?? { tools: { sessions: { visibility: "self" } } };
  return createSessionsSearchTool({
    config: {
      ...config,
      agents: {
        entries: { main: {} },
        ...config.agents,
      },
    },
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    sessionLinkBase: params.sessionLinkBase,
    callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
      params.requests?.push(request);
      const results = params.results ?? [];
      if (request.method === "sessions.list") {
        const listParams = request.params as { agentId?: unknown; spawnedBy?: unknown } | undefined;
        const spawnedBy = listParams?.spawnedBy;
        const agentId = listParams?.agentId;
        return {
          sessions: results
            .filter(
              (row) =>
                (spawnedBy === undefined || row.spawnedBy === spawnedBy) &&
                (agentId === undefined || row.agentId === agentId),
            )
            .map((row) => {
              const entry: Record<string, unknown> = { key: row.sessionKey };
              for (const key of ["agentId", "ownerSessionKey", "parentSessionKey", "spawnedBy"]) {
                if (typeof row[key] === "string") {
                  entry[key] = row[key];
                }
              }
              return entry;
            }),
          hasMore: false,
        } as T;
      }
      const sessionKeys = (request.params as { sessionKeys?: unknown } | undefined)?.sessionKeys;
      return {
        results: results.filter(
          (row) => Array.isArray(sessionKeys) && sessionKeys.includes(row.sessionKey),
        ),
        ...(params.indexing ? { indexing: true } : {}),
        ...(params.archivedTranscriptsExcluded
          ? { archivedTranscriptsExcluded: params.archivedTranscriptsExcluded }
          : {}),
        ...(params.truncated ? { truncated: true } : {}),
      } as T;
    },
  });
}

function searchTool(callGateway: typeof gatewayCall) {
  return createSessionsSearchTool({
    config: { tools: { sessions: { visibility: "self" } } },
    agentSessionKey: MAIN,
    callGateway: async <T>(request: CallGatewayRequest): Promise<T> =>
      request.method === "sessions.list"
        ? ({ sessions: [], hasMore: false } as T)
        : callGateway<T>(request),
  });
}

function expectSearch(
  requests: CallGatewayRequest[],
  agentId: string,
  sessionKeys: string[],
  query = "text",
) {
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "sessions.search",
      params: { agentId, query, limit: 25, sessionKeys },
    }),
  );
}

describe("sessions_search tool", () => {
  it("searches only same-channel candidates before returning snippets", async () => {
    const requester = "agent:main:slack:channel:c111:thread:1.001";
    const sibling = "agent:main:slack:channel:c111:thread:1.002";
    const other = "agent:main:slack:channel:c222:thread:1.003";
    const row = (key: string, to: string) => ({
      key,
      agentId: "main",
      chatType: "channel",
      space: "t111",
      origin: { provider: "slack", chatType: "channel" },
      deliveryContext: { channel: "slack", accountId: "default", to },
    });
    const rows = [
      row(requester, "channel:c111"),
      row(sibling, "channel:c111"),
      row(other, "channel:c222"),
    ];
    const owner = createSessionChannelReadFixture(
      rows.map((entry) => ({ ...entry, chatType: "channel" as const })),
    );
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsSearchTool({
      config: { tools: { sessions: { visibility: "channel" } } },
      agentSessionKey: requester,
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        if (request.method === "sessions.describe") {
          const key = (request.params as { key?: string }).key;
          return { session: rows.find((entry) => entry.key === key) } as T;
        }
        if (request.method === "sessions.list") {
          return { sessions: rows, hasMore: false } as T;
        }
        const keys = (request.params as { sessionKeys?: string[] }).sessionKeys ?? [];
        return {
          results: keys.map((key) =>
            hit({
              sessionKey: key,
              snippet: key === other ? "OTHER CUSTOMER SECRET" : "same channel context",
            }),
          ),
        } as T;
      },
    });
    const result = await owner.run(() => tool.execute("channel-search", { query: "context" }));
    expect(result.details).toMatchObject({
      results: [
        expect.objectContaining({ sessionKey: requester }),
        expect.objectContaining({ sessionKey: sibling }),
      ],
    });
    expect(JSON.stringify(result.details)).not.toContain("OTHER CUSTOMER SECRET");
    const searched = requests
      .filter((request) => request.method === "sessions.search")
      .flatMap((request) => (request.params as { sessionKeys: string[] }).sessionKeys);
    expect(searched).toContain(sibling);
    expect(searched).not.toContain(other);
  });

  it("rechecks same-channel authority after inventory before transcript search", async () => {
    const requester = "agent:main:slack:channel:c111:thread:2.001";
    const sibling = "agent:main:slack:channel:c111:thread:2.002";
    const makeRow = (key: string, to: string) => ({
      key,
      agentId: "main",
      chatType: "channel" as const,
      space: "t111",
      origin: { provider: "slack", chatType: "channel" as const },
      deliveryContext: { channel: "slack", accountId: "default", to },
    });
    const requesterRow = makeRow(requester, "channel:c111");
    const admittedSibling = makeRow(sibling, "channel:c111");
    const reassignedSibling = makeRow(sibling, "channel:c222");
    const requests: CallGatewayRequest[] = [];
    let inventoryReturned = false;
    const tool = createSessionsSearchTool({
      config: { tools: { sessions: { visibility: "channel" } } },
      agentSessionKey: requester,
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        if (request.method === "sessions.list") {
          inventoryReturned = true;
          return { sessions: [requesterRow, admittedSibling], hasMore: false } as T;
        }
        if (request.method === "sessions.describe") {
          const key = (request.params as { key?: string }).key;
          if (key === sibling) {
            return { session: inventoryReturned ? reassignedSibling : admittedSibling } as T;
          }
          return { session: requesterRow } as T;
        }
        const keys = (request.params as { sessionKeys?: string[] }).sessionKeys ?? [];
        return {
          results: keys.map((key) =>
            hit({
              sessionKey: key,
              snippet: key === sibling ? "REASSIGNED CHANNEL SECRET" : "requester context",
            }),
          ),
        } as T;
      },
    });

    const result = await tool.execute("channel-search-reassignment", { query: "context" });

    expect(JSON.stringify(result.details)).not.toContain("REASSIGNED CHANNEL SECRET");
    const searched = requests
      .filter((request) => request.method === "sessions.search")
      .flatMap((request) => (request.params as { sessionKeys: string[] }).sessionKeys);
    expect(searched).toEqual([requester]);
  });

  it("drops buffered hits whose channel authority changes during a later search", async () => {
    const requester = "agent:main:slack:channel:c111:thread:2.101";
    const firstSibling = "agent:main:slack:channel:c111:thread:2.102";
    const secondSibling = "agent:main:slack:channel:c111:thread:2.103";
    const makeRow = (key: string, to: string) => ({
      key,
      agentId: "main",
      chatType: "channel" as const,
      space: "t111",
      origin: { provider: "slack", chatType: "channel" as const },
      deliveryContext: { channel: "slack", accountId: "default", to },
    });
    const requesterRow = makeRow(requester, "channel:c111");
    const admittedFirst = makeRow(firstSibling, "channel:c111");
    const reassignedFirst = makeRow(firstSibling, "channel:c222");
    const secondRow = makeRow(secondSibling, "channel:c111");
    const owner = createSessionChannelReadFixture([requesterRow, admittedFirst, secondRow]);
    let currentFirst = admittedFirst;
    const searched: string[] = [];
    const tool = createSessionsSearchTool({
      config: { tools: { sessions: { visibility: "channel" } } },
      agentSessionKey: requester,
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        if (request.method === "sessions.list") {
          return {
            sessions: [requesterRow, admittedFirst, secondRow],
            hasMore: false,
          } as T;
        }
        if (request.method === "sessions.describe") {
          const key = (request.params as { key?: string }).key;
          if (key === firstSibling) {
            return { session: currentFirst } as T;
          }
          if (key === secondSibling) {
            return { session: secondRow } as T;
          }
          return { session: requesterRow } as T;
        }
        const keys = (request.params as { sessionKeys?: string[] }).sessionKeys ?? [];
        searched.push(...keys);
        if (keys.includes(secondSibling)) {
          currentFirst = reassignedFirst;
          owner.setRow(reassignedFirst);
        }
        return {
          results: keys.map((key) =>
            hit({
              sessionKey: key,
              snippet:
                key === firstSibling
                  ? "BUFFERED REASSIGNED CHANNEL SECRET"
                  : "same channel context",
            }),
          ),
        } as T;
      },
    });

    const result = await owner.run(() =>
      tool.execute("channel-search-final-revalidation", {
        query: "context",
      }),
    );

    expect(searched).toEqual([requester, firstSibling, secondSibling]);
    expect(JSON.stringify(result.details)).not.toContain("BUFFERED REASSIGNED CHANNEL SECRET");
    expect(result.details).toMatchObject({
      results: [
        expect.objectContaining({ sessionKey: requester }),
        expect.objectContaining({ sessionKey: secondSibling }),
      ],
    });
  });

  it("drops earlier hits revoked while another final description is pending", async () => {
    const requester = "agent:main:slack:channel:c111:thread:2.201";
    const firstSibling = "agent:main:slack:channel:c111:thread:2.202";
    const secondSibling = "agent:main:slack:channel:c111:thread:2.203";
    const makeRow = (key: string, to = "channel:c111") => ({
      key,
      agentId: "main",
      chatType: "channel" as const,
      space: "t111",
      origin: { provider: "slack", chatType: "channel" as const },
      deliveryContext: { channel: "slack", accountId: "default", to },
    });
    const requesterRow = makeRow(requester);
    const firstRow = makeRow(firstSibling);
    const secondRow = makeRow(secondSibling);
    const owner = createSessionChannelReadFixture([requesterRow, firstRow, secondRow]);
    let currentFirst = firstRow;
    const searched: string[] = [];
    const tool = createSessionsSearchTool({
      config: { tools: { sessions: { visibility: "channel" } } },
      agentSessionKey: requester,
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        if (request.method === "sessions.list") {
          return { sessions: [requesterRow, firstRow, secondRow], hasMore: false } as T;
        }
        if (request.method === "sessions.describe") {
          const key = (request.params as { key?: string }).key;
          if (key === secondSibling && searched.length === 3) {
            // The first final check already succeeded; a later awaited check revokes it.
            await Promise.resolve();
            currentFirst = makeRow(firstSibling, "channel:c222");
            owner.setRow(currentFirst);
          }
          return {
            session:
              key === firstSibling
                ? currentFirst
                : key === secondSibling
                  ? secondRow
                  : requesterRow,
          } as T;
        }
        const keys = (request.params as { sessionKeys?: string[] }).sessionKeys ?? [];
        searched.push(...keys);
        return {
          results: keys.map((key) =>
            hit({
              sessionKey: key,
              snippet: key === firstSibling ? "FINAL CHECK REVOKED SECRET" : "channel context",
            }),
          ),
        } as T;
      },
    });

    const result = await owner.run(() =>
      tool.execute("channel-search-final-description-revocation", {
        query: "context",
      }),
    );

    expect(searched).toEqual([requester, firstSibling, secondSibling]);
    expect(JSON.stringify(result.details)).not.toContain("FINAL CHECK REVOKED SECRET");
  });

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.each([false, true])(
    "requires a live disclosure owner only for cross-session channel hits (%s)",
    async (includeSibling) => {
      const requester = "agent:main:slack:channel:c111:thread:2.301";
      const sibling = "agent:main:slack:channel:c111:thread:2.302";
      const rows = [requester, ...(includeSibling ? [sibling] : [])].map((key) => ({
        key,
        agentId: "main",
        chatType: "channel",
        space: "t111",
        origin: { provider: "slack", chatType: "channel" },
        deliveryContext: { channel: "slack", accountId: "default", to: "channel:c111" },
      }));
      const tool = createSessionsSearchTool({
        config: { tools: { sessions: { visibility: "channel" } } },
        agentSessionKey: requester,
        callGateway: async <T = Record<string, unknown>>(
          request: CallGatewayRequest,
        ): Promise<T> => {
          if (request.method === "sessions.list") {
            return { sessions: rows, hasMore: false } as T;
          }
          if (request.method === "sessions.describe") {
            return {
              session: rows.find((row) => row.key === (request.params as { key: string }).key),
            } as T;
          }
          return {
            results: (request.params as { sessionKeys: string[] }).sessionKeys.map((key) =>
              hit({ sessionKey: key }),
            ),
          } as T;
        },
      });
      const result = tool.execute("channel-search-missing-owner", { query: "context" });
      if (includeSibling) {
        await expect(result).rejects.toThrow(
          "Cross-session channel retrieval requires the local Gateway read owner",
        );
      } else {
        expect((await result).details).toMatchObject({
          results: [expect.objectContaining({ sessionKey: requester })],
        });
      }
    },
  );

  it("rejects route reassignment after description but before transcript I/O", async () => {
    const requester = "agent:main:slack:channel:c111:thread:3.001";
    const sibling = "agent:main:slack:channel:c111:thread:3.002";
    const store = path.join(tempDirs.make("openclaw-channel-admission-"), "sessions.sqlite");
    replaceSessionEntrySync(
      { storePath: store, sessionKey: requester },
      { sessionId: "requester-session", updatedAt: 1 },
    );
    replaceSessionEntrySync(
      { storePath: store, sessionKey: sibling },
      { sessionId: "sibling-session", updatedAt: 1 },
    );
    const makeRow = (key: string, sessionId: string, to: string) => ({
      key,
      agentId: "main",
      sessionId,
      chatType: "channel" as const,
      space: "t111",
      origin: { provider: "slack", chatType: "channel" as const },
      deliveryContext: { channel: "slack", accountId: "default", to },
    });
    const requesterRow = makeRow(requester, "requester-session", "channel:c111");
    const admittedSibling = makeRow(sibling, "sibling-session", "channel:c111");
    const reassignedSibling = makeRow(sibling, "sibling-session", "channel:c222");
    const requests: CallGatewayRequest[] = [];
    let siblingDescriptions = 0;
    const tool = createSessionsSearchTool({
      config: {
        session: { store },
        tools: { sessions: { visibility: "channel" } },
      },
      agentSessionKey: requester,
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        if (request.method === "sessions.list") {
          return { sessions: [requesterRow, admittedSibling], hasMore: false } as T;
        }
        if (request.method === "sessions.describe") {
          const key = (request.params as { key?: string }).key;
          if (key === sibling) {
            siblingDescriptions += 1;
            return {
              session: siblingDescriptions === 1 ? admittedSibling : reassignedSibling,
            } as T;
          }
          return { session: requesterRow } as T;
        }
        return {
          results: [
            hit({
              sessionKey: sibling,
              snippet: "POST-DESCRIPTION REASSIGNED SECRET",
            }),
          ],
        } as T;
      },
    });

    const result = await tool.execute("channel-search-admission-reassignment", {
      query: "context",
      sessionKey: sibling,
    });

    expect(result.details).toMatchObject({ results: [] });
    expect(JSON.stringify(result.details)).not.toContain("POST-DESCRIPTION REASSIGNED SECRET");
    expect(requests.some((request) => request.method === "sessions.search")).toBe(false);
    expect(siblingDescriptions).toBe(2);
  });

  it.each(["result", "timeout"] as const)(
    "keeps a slow transcript read alive through its worker budget, ending in %s",
    async (outcome) => {
      vi.useFakeTimers();
      const entered = createDeferred();
      const response = createDeferred<{ results: Array<Record<string, unknown>> }>();
      const tool = searchTool(async <T>(request: CallGatewayRequest): Promise<T> => {
        const pending = waitForGatewayDispatch(
          request.method,
          response.promise,
          request.timeoutMs ?? 10_000,
        );
        entered.resolve();
        return (await pending) as T;
      });
      let settled = false;
      const pending = tool.execute("slow-search", { query: "needle" }).finally(() => {
        settled = true;
      });
      // Observe rejection before advancing the dispatch deadline's fake clock.
      const result = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(10_001);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(50_000);
        expect(settled).toBe(false);
        if (outcome === "result") {
          response.resolve({
            results: [hit({ sessionKey: MAIN, snippet: "needle found" })],
          });
          expect(await result).toMatchObject({
            value: { details: { results: [{ messageId: "message-1", snippet: "needle found" }] } },
          });
        } else {
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await result).toMatchObject({
            error: {
              message: expect.stringMatching(/Retry sessions_search with a sessionKey/),
              cause: { code: "CLIENT_TIMEOUT", method: "sessions.search", timeoutMs: 90_000 },
            },
          });
        }
      } finally {
        response.resolve({ results: [] });
        await result;
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { kind: "timeout", requestDispatched: true, guidance: true },
    { kind: "timeout", requestDispatched: false, guidance: false },
    { kind: "closed", requestDispatched: true, guidance: false },
    { kind: "authority", requestDispatched: false, guidance: false },
  ] as const)(
    "preserves transport diagnostics for $kind, dispatched=$requestDispatched",
    async ({ kind, requestDispatched, guidance }) => {
      const failure =
        kind === "authority"
          ? new Error("Session search scope changed while reading; retry the request")
          : new GatewayTransportError({
              kind,
              requestDispatched,
              message: "synthetic transport failure",
              connectionDetails: {
                url: "ws://127.0.0.1:40001",
                urlSource: "fixture",
                message: "fixture",
              },
            });
      const tool = searchTool(async () => {
        throw failure;
      });
      const pending = tool.execute("transport-search", { query: "needle" });
      if (guidance) {
        await expect(pending).rejects.toMatchObject({
          message: expect.stringMatching(/Retry sessions_search with a sessionKey/),
          cause: failure,
        });
      } else {
        await expect(pending).rejects.toBe(failure);
      }
    },
  );

  it("rejects a literal global target owned by another fixed-store agent when agent-to-agent is disabled", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      agentId: "research",
      agentSessionKey: "agent:research:main",
      config: {
        session: { store: "/stores/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { research: {}, ops: {} },
        },
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: false } },
      },
      results: [hit({ sessionKey: "global", agentId: "ops" })],
      requests,
    });

    const result = await search(tool, { sessionKey: "global" });

    expect(result.details).toMatchObject({ status: "forbidden" });
    expect(requests.some((request) => request.method === "sessions.search")).toBe(false);
  });

  it("declares exact success and error result contracts", async () => {
    const tool = createTool({ results: [hit()] });
    const success = await search(tool);
    const linkedSuccess = await createTool({
      results: [hit()],
      sessionLinkBase: SESSION_LINK_BASE,
    }).execute("linked-success-contract", { query: "text" });
    const error = await search(tool, {
      sessionKey: "01234567-89ab-4def-8123-456789abcdef",
    });

    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, success.details)).toBe(true);
    expect(success.details).not.toHaveProperty("sessionLinkRule");
    expect(linkedSuccess.details).toHaveProperty("sessionLinkRule", SESSION_LINK_RULE);
    expect(error.details).toMatchObject({ status: "error", error: expect.any(String) });
    expect(Value.Check(tool.outputSchema!, error.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ results: Array<{ role: "assistant" | "user"; score: number; sessionKey: string; snippet: string; timestamp: number; messageId?: string; sessionId?: string }>; archivedTranscriptsExcluded?: number; indexing?: true; sessionLinkRule?: string; truncated?: true; warning?: string } | { error: string; status: "error" | "forbidden" }',
    );
  });

  it("reports indexing and archived transcript exclusions", async () => {
    const state = { indexing: true, archivedTranscriptsExcluded: 2 };
    const result = await createTool({
      results: [hit()],
      ...state,
    }).execute("indexing-warning", { query: "text" });

    expect(result.details).toMatchObject({
      indexing: true,
      archivedTranscriptsExcluded: 2,
      warning:
        "Transcript indexing is in progress; results may be incomplete. Retry sessions_search shortly. Search excludes 2 archived transcripts. Restore a transcript to include it in search.",
    });
    expect(Value.Check(createTool({}).outputSchema!, result.details)).toBe(true);
  });

  it("rejects empty queries and invalid limits", async () => {
    const tool = createTool({});
    expect(Value.Check(tool.parameters, { query: "" })).toBe(false);
    expect(Value.Check(tool.parameters, { query: "loan" })).toBe(true);
    expect(Value.Check(tool.parameters, { query: "  loan  " })).toBe(true);
    expect(tool.parameters).toMatchObject({
      properties: { limit: { description: expect.stringContaining("Maximum search results: 25") } },
    });
    await expect(tool.execute("call-1", { query: "   " })).rejects.toThrow(
      "query must not be empty",
    );
    await expect(tool.execute("call-2", { query: "ok", limit: 26 })).rejects.toThrow(
      "limit must be a positive integer",
    );
    await expect(tool.execute("call-3", { query: "x".repeat(4097) })).rejects.toThrow(
      "query must not exceed 4096 characters",
    );
  });

  it("rejects blank execution with retry guidance after OpenAI schema normalization", async () => {
    const tool = normalizeToolParameters(createTool({}), { modelProvider: "openai" });
    for (const query of ["", "   "]) {
      await expect(tool.execute!("blank-query", { query })).rejects.toThrow(
        /query must not be empty; retry with non-empty keywords/,
      );
    }
  });

  it("never searches or returns incognito sessions", async () => {
    const requests: CallGatewayRequest[] = [];
    const incognitoKey = "agent:main:dashboard:incognito-private";
    const tool = createTool({
      requests,
      config: { tools: { sessions: { visibility: "all" } } },
      results: [
        hit({ sessionKey: "agent:main:visible", messageId: "visible" }),
        hit({ sessionKey: incognitoKey, messageId: "private" }),
      ],
    });

    const result = await search(tool);
    const explicit = await search(tool, { sessionKey: incognitoKey });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "visible" })],
    });
    expect(JSON.stringify(result.details)).not.toContain("private");
    expect(explicit.details).toMatchObject({ status: "forbidden" });
    expect(
      requests
        .filter((request) => request.method === "sessions.search")
        .flatMap((request) => {
          const keys = (request.params as { sessionKeys?: unknown }).sessionKeys;
          return Array.isArray(keys) ? keys : [];
        }),
    ).not.toContain(incognitoKey);
  });

  it("excludes foreign unscoped sessions that cannot be reopened by session key", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      agentId: "main",
      config: fixtureConfig("all", ["main", "work"], true),
      results: [hit({ sessionKey: "global", agentId: "work", messageId: "work-global" })],
    });

    const result = await search(tool);

    const searchRequests = requests.filter((request) => request.method === "sessions.search");
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.params).toMatchObject({ agentId: "main" });
    expect(result.details).toMatchObject({ results: [] });
  });

  it("keeps an unscoped current session in the requester agent store", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      agentId: "work",
      agentSessionKey: "global",
      config: fixtureConfig("agent", ["main", "work"]),
      results: [
        hit({ sessionKey: "global", agentId: "work" }),
        hit({ sessionKey: WORK, agentId: "work", messageId: "work-other" }),
      ],
    });

    const result = await search(tool);

    expect(result.details).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ sessionKey: "global" }),
        expect.objectContaining({ sessionKey: WORK }),
      ]),
    });
    expectSearch(requests, "work", [WORK, "global"]);
  });

  it("uses the target agent for an explicit cross-agent session", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      agentId: "main",
      agentSessionKey: MAIN,
      config: fixtureConfig("all", ["main", "work"], true),
      results: [hit({ sessionKey: WORK, agentId: "work" })],
    });

    await search(tool, { sessionKey: WORK });

    expectSearch(requests, "work", [WORK]);
  });

  it("accepts the gateway's canonical key for the current-session alias", async () => {
    const tool = createSessionsSearchTool({
      config: fixtureConfig("self"),
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        if (request.method === "sessions.list") {
          return { sessions: [], hasMore: false } as T;
        }
        return {
          results: [
            hit({ sessionKey: MAIN, messageId: "canonical-main" }),
            hit({ sessionKey: "agent:work:main", messageId: "wrong-agent" }),
          ],
        } as T;
      },
    });

    const result = await search(tool);

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "canonical-main", sessionKey: "main" })],
    });
    expect(JSON.stringify(result.details)).not.toContain("wrong-agent");
  });

  it("clamps sandboxed callers to spawned sessions", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      agentSessionKey: MAIN,
      sandboxed: true,
      requests,
      config: {
        tools: { sessions: { visibility: "all" } },
        agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
      },
      results: [
        hit({
          sessionKey: "agent:main:child:spawned",
          messageId: "spawned",
          spawnedBy: MAIN,
        }),
        hit({ sessionKey: "agent:main:other", messageId: "other" }),
      ],
    });

    const result = await search(tool);

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "spawned" })],
    });
    expect(JSON.stringify(result.details)).not.toContain('"other"');
    const searchedKeys = requests
      .filter((request) => request.method === "sessions.search")
      .map((request) => (request.params as { sessionKeys?: unknown }).sessionKeys);
    expect(searchedKeys).toEqual([["agent:main:child:spawned", MAIN]]);
  });

  it("preserves and truncates snippets, limits rows, and caps bytes", async () => {
    const token = ["sk", "or", "v1", "abcdef0123456789"].join("-");
    // Assembled so the pre-review secret scanner never sees a key-shaped literal.
    const keyShaped = `${["OPENROUTER", "API", "KEY"].join("_")}=${token}`;
    const results = Array.from({ length: 12 }, (_, index) =>
      hit({
        messageId: `message-${index}`,
        snippet: `${keyShaped} ${"x".repeat(400)}`,
      }),
    );
    const tool = createTool({ results });

    const limited = await search(tool, { limit: 2 });
    const details = limited.details as { results: unknown[]; truncated?: boolean };
    expect(details.results).toHaveLength(2);
    expect(details.truncated).toBe(true);
    expect(JSON.stringify(details)).toContain(token);

    const capped = await search(createTool({ results: [hit({ messageId: "x".repeat(40_000) })] }));
    expect(capped.details).toMatchObject({ results: [], truncated: true });

    const backendLimitedResult = await search(createTool({ results: [hit()], truncated: true }), {
      limit: 2,
    });
    expect(backendLimitedResult.details).toMatchObject({ truncated: true });
  });

  it("resolves and sends a one-session restriction", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({ requests, results: [hit()] });

    await search(tool, { query: " text ", sessionKey: "main", limit: 3 });

    expectSearch(requests, "main", ["main"]);
  });

  it("rejects a scoped grant when the target incarnation changes before search", async () => {
    const requesterSessionKey = "agent:main:clickclack:discussion-race";
    const targetSessionKey = MAIN;
    const expectedSessionId = "old-incarnation";
    const storePath = path.join(tempDirs.make("openclaw-sessions-search-"), "sessions.sqlite");
    replaceSessionEntrySync(
      { storePath, sessionKey: targetSessionKey },
      { sessionId: expectedSessionId, updatedAt: 1 },
    );
    const requests: CallGatewayRequest[] = [];
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) => {
      if (
        request.requesterSessionKey !== requesterSessionKey ||
        request.targetSessionKey !== targetSessionKey
      ) {
        return undefined;
      }
      replaceSessionEntrySync(
        { storePath, sessionKey: targetSessionKey },
        { sessionId: "replacement-incarnation", updatedAt: 2 },
      );
      return { expectedSessionId };
    });
    try {
      const tool = createSessionsSearchTool({
        agentSessionKey: requesterSessionKey,
        sandboxed: true,
        config: {
          session: { store: storePath },
          tools: { sessions: { visibility: "self" } },
          agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
        } as OpenClawConfig,
        callGateway: async <T = Record<string, unknown>>(
          request: CallGatewayRequest,
        ): Promise<T> => {
          requests.push(request);
          return { results: [hit({ sessionKey: targetSessionKey })] } as T;
        },
      });

      await expect(
        tool.execute("scoped-grant-race", { query: "text", sessionKey: targetSessionKey }),
      ).rejects.toThrow(`Session "${targetSessionKey}" changed after access was granted.`);
      expect(requests.some((request) => request.method === "sessions.search")).toBe(false);
    } finally {
      unregister();
    }
  });
});
