import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import * as sessionKeys from "../../routing/session-key.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

type GatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

function searchHit(sessionKey: string, ordinal = 0) {
  return {
    sessionKey,
    sessionId: `session-${ordinal}`,
    messageId: `message-${ordinal}`,
    role: "assistant" as const,
    timestamp: 100 + ordinal,
    snippet: `matching text ${ordinal}`,
    score: 25 - ordinal,
  };
}

function createSearchFixture(
  keys: string[],
  results:
    | ReturnType<typeof searchHit>[]
    | ((request: GatewayRequest) => ReturnType<typeof searchHit>[]),
  onListed?: () => void,
) {
  const requests: GatewayRequest[] = [];
  const tool = createSessionsSearchTool({
    agentSessionKey: "agent:main:requester",
    config: {
      agents: { entries: { main: { default: true } } },
      tools: { sessions: { visibility: "all" } },
    },
    callGateway: async <T>(request: GatewayRequest): Promise<T> => {
      requests.push(request);
      if (request.method === "sessions.list") {
        const params = request.params as { archived: boolean; agentId?: string };
        if (params.archived && params.agentId === "main") {
          onListed?.();
        }
        return {
          sessions: params.archived ? [] : keys.map((key) => ({ key, agentId: "main" })),
          hasMore: false,
        } as T;
      }
      expect(request.method).toBe("sessions.search");
      return { results: typeof results === "function" ? results(request) : results } as T;
    },
  });
  return { tool, requests };
}

describe("sessions_search candidate matching", () => {
  it("bounds key parsing across a full candidate chunk and 25 canonical hits", async () => {
    const aliases = Array.from(
      { length: 199 },
      (_, index) => `session-${String(index).padStart(3, "0")}`,
    );
    const keys = ["agent:main:requester", ...aliases];
    const returned = aliases.slice(-25).map((key, index) => searchHit(`agent:main:${key}`, index));
    const parse = vi.spyOn(sessionKeys, "parseAgentSessionKey");
    try {
      const { tool, requests } = createSearchFixture(keys, returned, () => parse.mockClear());
      const result = await tool.execute("candidate-budget", { query: "text", limit: 25 });
      expect(result.details).toEqual({
        results: returned.map((row, index) =>
          Object.assign({}, row, { sessionKey: aliases[174 + index] }),
        ),
      });
      expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
      expect(requests.filter((request) => request.method === "sessions.search")).toEqual([
        {
          method: "sessions.search",
          params: { agentId: "main", query: "text", limit: 25, sessionKeys: keys },
        },
      ]);
      expect(requests.filter((request) => request.method === "sessions.list")).toHaveLength(4);
      const aliasKeys = new Set(aliases);
      const aliasParses = parse.mock.calls.filter(
        ([key]) => typeof key === "string" && aliasKeys.has(key),
      );
      expect(aliasParses.length).toBeLessThanOrEqual(1_000);
    } finally {
      parse.mockRestore();
    }
  });

  it.each([
    { keys: ["aaa", "agent:main:aaa"], hitKey: "agent:main:aaa", expected: "aaa" },
    { keys: ["agent:main:zzz", "zzz"], hitKey: "agent:main:zzz", expected: "agent:main:zzz" },
    { keys: [" aaa ", "aaa"], hitKey: "agent:main:aaa", expected: " aaa " },
  ])("keeps the first matching candidate for $keys", async ({ keys, hitKey, expected }) => {
    const { tool, requests } = createSearchFixture(keys, [searchHit(hitKey)]);
    const result = await tool.execute("candidate-order", { query: "text" });
    expect(result.details).toEqual({ results: [{ ...searchHit(hitKey), sessionKey: expected }] });
    const request = requests.find((entry) => entry.method === "sessions.search");
    if (!request) {
      throw new Error("Missing sessions.search request");
    }
    const requested = (request.params as { sessionKeys: string[] }).sessionKeys.filter(
      (key) => key !== "agent:main:requester",
    );
    expect(requested).toEqual(keys);
  });

  it.each([
    { key: "agent:main:Mixed", accepted: "agent:main:Mixed", rejected: "agent:main:mixed" },
    { key: " room ", accepted: "agent:main:room", rejected: "agent:work:room" },
    { key: "Room", accepted: "Room", rejected: "agent:main:room" },
    {
      key: "matrix:channel:!AbC:example.org:thread:$Event",
      accepted: "agent:main:matrix:channel:!AbC:example.org:thread:$Event",
      rejected: "agent:main:matrix:channel:!abc:example.org:thread:$Event",
    },
    {
      key: "signal:group:AbC",
      accepted: "agent:main:signal:group:AbC",
      rejected: "agent:main:signal:group:abc",
    },
  ])("preserves raw and opaque key identity for $key", async ({ key, accepted, rejected }) => {
    const { tool } = createSearchFixture([key], [searchHit(rejected, 1), searchHit(accepted)]);
    const result = await tool.execute("key-identity", { query: "text" });
    expect(result.details).toEqual({ results: [{ ...searchHit(accepted), sessionKey: key }] });
  });

  it("matches hits only within the chunk sent to that search request", async () => {
    const aliases = Array.from(
      { length: 200 },
      (_, index) => `session-${String(index).padStart(3, "0")}`,
    );
    const { tool, requests } = createSearchFixture(aliases, (request) => {
      const requested = (request.params as { sessionKeys: string[] }).sessionKeys;
      return requested.length === 200 ? [searchHit("agent:main:session-199")] : [];
    });
    const result = await tool.execute("chunk-isolation", { query: "text" });
    expect(result.details).toEqual({ results: [] });
    expect(
      requests
        .filter((request) => request.method === "sessions.search")
        .map((request) => (request.params as { sessionKeys: string[] }).sessionKeys),
    ).toEqual([["agent:main:requester", ...aliases.slice(0, 199)], ["session-199"]]);
  });
});
