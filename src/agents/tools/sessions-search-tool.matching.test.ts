import { describe, expect, it } from "vitest";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

describe("sessions_search explicit target matching", () => {
  it.each(["agent:main:Mixed", "agent:main:matrix:channel:!AbC:example.org:thread:$Event"])(
    "preserves the exact authorized key %s",
    async (sessionKey) => {
      const hit = {
        sessionKey,
        sessionId: "target-session",
        messageId: "target-message",
        role: "assistant",
        timestamp: 100,
        snippet: "matching text",
        score: 1,
      };
      const tool = createSessionsSearchTool({
        agentSessionKey: sessionKey,
        config: {
          agents: { entries: { main: {} } },
          tools: { sessions: { visibility: "self" } },
        },
        callGateway: async <T>(request: { method: string }): Promise<T> => {
          expect(request.method).toBe("sessions.search");
          return { results: [hit, { ...hit, sessionKey: sessionKey.toLowerCase() }] } as T;
        },
      });
      const result = await tool.execute("exact-target", { query: "text" });
      expect(result.details).toEqual({ results: [hit] });
    },
  );
});
