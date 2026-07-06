// sessions_search tool tests cover visibility filtering and input validation.
import { describe, expect, it } from "vitest";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];

function readDetails(result: { details: unknown }): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

describe("sessions_search", () => {
  it("filters listed sessions before issuing the search", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsSearchTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        if (request.method === "sessions.list") {
          return {
            sessions: [
              { key: "agent:main:main", agentId: "main", kind: "main", channel: "unknown" },
              {
                key: "agent:main:child",
                agentId: "main",
                kind: "other",
                channel: "unknown",
                spawnedBy: "agent:main:main",
              },
              {
                key: "agent:main:sibling",
                agentId: "main",
                kind: "other",
                channel: "unknown",
              },
              { key: "agent:work:main", agentId: "work", kind: "main", channel: "unknown" },
            ],
          } as T;
        }
        if (request.method === "sessions.search") {
          return {
            query: "needle",
            hits: [
              {
                sessionKey: "agent:main:child",
                sessionId: "sess-child",
                agentId: "main",
                seq: 3,
                role: "assistant",
                snippet: "found needle",
              },
            ],
            indexedSessions: 2,
            searchedSessions: 2,
          } as T;
        }
        throw new Error(`unexpected gateway method: ${request.method}`);
      },
    });

    const result = await tool.execute("call-1", { query: "needle", limit: 4 });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "sessions.list",
      params: {
        limit: 200,
        includeDerivedTitles: false,
        includeLastMessage: false,
        includeGlobal: true,
        includeUnknown: false,
      },
    });
    expect(requests[1]).toMatchObject({
      method: "sessions.search",
      params: {
        query: "needle",
        sessionKeys: ["agent:main:main", "agent:main:child"],
        limit: 4,
      },
    });
    expect(readDetails(result)).toMatchObject({
      query: "needle",
      indexedSessions: 2,
      searchedSessions: 2,
      hits: [
        {
          sessionKey: "agent:main:child",
          sessionId: "sess-child",
          snippet: "found needle",
        },
      ],
    });
  });

  it("searches an explicit self session without listing", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsSearchTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "self" } } },
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return {
          query: "needle",
          hits: [],
          indexedSessions: 1,
          searchedSessions: 1,
        } as T;
      },
    });

    const result = await tool.execute("call-1", {
      query: "needle",
      sessionKey: "agent:main:main",
    });

    expect(requests).toEqual([
      {
        method: "sessions.search",
        params: {
          query: "needle",
          sessionKeys: ["agent:main:main"],
        },
      },
    ]);
    expect(readDetails(result)).toMatchObject({
      query: "needle",
      indexedSessions: 1,
      searchedSessions: 1,
      hits: [],
    });
  });

  it("rejects limits above the tool cap", async () => {
    const tool = createSessionsSearchTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(): Promise<T> => ({}) as T,
    });

    await expect(tool.execute("call-1", { query: "needle", limit: 21 })).rejects.toThrow(
      "limit must be a positive integer no greater than 20",
    );
  });
});
