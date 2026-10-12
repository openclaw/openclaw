/** sessions_search visibility, bounds, redaction, and input tests. */
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import { normalizeToolParameters } from "../agent-tools.schema.js";
import { describeSessionLinkRule } from "../tool-description-presets.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];
const SESSION_LINK_BASE = "http://127.0.0.1:18789/control";
const SESSION_LINK_RULE = describeSessionLinkRule(SESSION_LINK_BASE);

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
  config?: Record<string, unknown>;
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
        ...(config.agents as Record<string, unknown> | undefined),
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
              if (typeof row.agentId === "string") {
                entry.agentId = row.agentId;
              }
              if (typeof row.ownerSessionKey === "string") {
                entry.ownerSessionKey = row.ownerSessionKey;
              }
              if (typeof row.parentSessionKey === "string") {
                entry.parentSessionKey = row.parentSessionKey;
              }
              if (typeof row.spawnedBy === "string") {
                entry.spawnedBy = row.spawnedBy;
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
    const result = await tool.execute("channel-search", { query: "context" });
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

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

    const result = await tool.execute("foreign-global", {
      query: "text",
      sessionKey: "global",
    });

    expect(result.details).toMatchObject({ status: "forbidden" });
    expect(requests.some((request) => request.method === "sessions.search")).toBe(false);
  });

  it("declares exact success and error result contracts", async () => {
    const tool = createTool({ results: [hit()] });
    const success = await tool.execute("success-contract", { query: "text" });
    const linkedSuccess = await createTool({
      results: [hit()],
      sessionLinkBase: SESSION_LINK_BASE,
    }).execute("linked-success-contract", { query: "text" });
    const error = await tool.execute("error-contract", {
      query: "text",
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
      ...(state.indexing ? { indexing: true } : {}),
      ...(state.archivedTranscriptsExcluded ? { archivedTranscriptsExcluded: 2 } : {}),
      warning: [
        ...(state.indexing
          ? [
              "Transcript indexing is in progress; results may be incomplete. Retry sessions_search shortly.",
            ]
          : []),
        ...(state.archivedTranscriptsExcluded
          ? [
              "Search excludes 2 archived transcripts. Restore a transcript to include it in search.",
            ]
          : []),
      ].join(" "),
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

    const result = await tool.execute("blind", { query: "text" });
    const explicit = await tool.execute("blind-explicit", {
      query: "text",
      sessionKey: incognitoKey,
    });

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
      config: {
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        agents: { entries: { main: {}, work: {} } },
      },
      results: [hit({ sessionKey: "global", agentId: "work", messageId: "work-global" })],
    });

    const result = await tool.execute("call-1", { query: "text" });

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
      config: {
        tools: { sessions: { visibility: "agent" } },
        agents: { entries: { main: {}, work: {} } },
      },
      results: [
        hit({ sessionKey: "global", agentId: "work" }),
        hit({ sessionKey: "agent:work:other", agentId: "work", messageId: "work-other" }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ sessionKey: "global" }),
        expect.objectContaining({ sessionKey: "agent:work:other" }),
      ]),
    });
    expect(requests).toContainEqual({
      method: "sessions.search",
      params: {
        agentId: "work",
        query: "text",
        limit: 25,
        sessionKeys: ["agent:work:other", "global"],
      },
    });
  });

  it("uses the target agent for an explicit cross-agent session", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      agentId: "main",
      agentSessionKey: "agent:main:main",
      config: {
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        agents: { entries: { main: {}, work: {} } },
      },
      results: [hit({ sessionKey: "agent:work:other", agentId: "work" })],
    });

    await tool.execute("call-1", { query: "text", sessionKey: "agent:work:other" });

    expect(requests).toContainEqual({
      method: "sessions.search",
      params: {
        agentId: "work",
        query: "text",
        limit: 25,
        sessionKeys: ["agent:work:other"],
      },
    });
  });

  it("accepts the gateway's canonical key for the current-session alias", async () => {
    const tool = createSessionsSearchTool({
      config: {
        agents: { entries: { main: {} } },
        tools: { sessions: { visibility: "self" } },
      },
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        if (request.method === "sessions.list") {
          return { sessions: [], hasMore: false } as T;
        }
        return {
          results: [
            hit({ sessionKey: "agent:main:main", messageId: "canonical-main" }),
            hit({ sessionKey: "agent:work:main", messageId: "wrong-agent" }),
          ],
        } as T;
      },
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "canonical-main", sessionKey: "main" })],
    });
    expect(JSON.stringify(result.details)).not.toContain("wrong-agent");
  });

  it("clamps sandboxed callers to spawned sessions", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      agentSessionKey: "agent:main:main",
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
          spawnedBy: "agent:main:main",
        }),
        hit({ sessionKey: "agent:main:other", messageId: "other" }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "spawned" })],
    });
    expect(JSON.stringify(result.details)).not.toContain('"other"');
    const searchedKeys = requests
      .filter((request) => request.method === "sessions.search")
      .map((request) => (request.params as { sessionKeys?: unknown }).sessionKeys);
    expect(searchedKeys).toEqual([["agent:main:child:spawned", "agent:main:main"]]);
  });

  it("redacts and truncates snippets, limits rows, and caps bytes", async () => {
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

    const limited = await tool.execute("call-1", { query: "text", limit: 2 });
    const details = limited.details as { results: unknown[]; truncated?: boolean };
    expect(details.results).toHaveLength(2);
    expect(details.truncated).toBe(true);
    expect(JSON.stringify(details)).not.toContain(token);

    const oversized = createTool({
      results: [hit({ messageId: "x".repeat(40_000) })],
    });
    const capped = await oversized.execute("call-2", { query: "text" });
    expect(capped.details).toMatchObject({ results: [], truncated: true });

    const backendLimited = createTool({ results: [hit()], truncated: true });
    const backendLimitedResult = await backendLimited.execute("call-3", {
      query: "text",
      limit: 2,
    });
    expect(backendLimitedResult.details).toMatchObject({ truncated: true });
  });

  it("resolves and sends a one-session restriction", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({ requests, results: [hit()] });

    await tool.execute("call-1", { query: " text ", sessionKey: "main", limit: 3 });

    expect(requests).toContainEqual({
      method: "sessions.search",
      params: { agentId: "main", query: "text", sessionKeys: ["main"], limit: 25 },
    });
  });

  it("rejects a scoped grant when the target incarnation changes before search", async () => {
    const requesterSessionKey = "agent:main:clickclack:discussion-race";
    const targetSessionKey = "agent:main:main";
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
