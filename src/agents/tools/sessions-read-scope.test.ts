import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

const observed = "agent:main:observed";
const internal = "agent:main:internal-session-effects:companion";
const sibling = "agent:main:unrelated";
const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: { sessions: { visibility: "all" } },
};

describe("host-bound session read scope", () => {
  it.each(["history", "search"] as const)(
    "reads only the observed session through %s",
    async (kind) => {
      const callGateway = vi.fn(async (request: { method: string; params?: unknown }) => {
        const params = request.params as { key?: string; sessionKeys?: string[] } | undefined;
        if (request.method === "sessions.resolve") {
          return { key: params?.key, agentId: "main" };
        }
        if (request.method === "sessions.list") {
          return {
            sessions: [observed, internal, sibling].map((key) => ({ key, agentId: "main" })),
          };
        }
        if (request.method === "sessions.search") {
          return {
            results: (params?.sessionKeys ?? []).map((sessionKey) => ({
              sessionKey,
              role: "assistant",
              snippet: "observed evidence",
              timestamp: 1,
              score: 1,
            })),
          };
        }
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "observed evidence" }] }],
        };
      });
      const options = {
        config,
        agentSessionKey: internal,
        sessionReadScopeKey: observed,
        // The transport mock is generic, just like the Gateway caller contract.
        callGateway: callGateway as NonNullable<
          Parameters<typeof createSessionsHistoryTool>[0]
        >["callGateway"],
      };
      const tool =
        kind === "history" ? createSessionsHistoryTool(options) : createSessionsSearchTool(options);
      const args = kind === "history" ? {} : { query: "evidence" };
      const result = await tool.execute("observed", { ...args, sessionKey: observed });
      expect(result.details).toMatchObject(
        kind === "history"
          ? { sessionKey: observed, messages: [{ role: "assistant" }] }
          : { results: [{ sessionKey: observed, snippet: "observed evidence" }] },
      );
      for (const sessionKey of [internal, sibling]) {
        callGateway.mockClear();
        expect((await tool.execute("denied", { ...args, sessionKey })).details).toMatchObject({
          status: "forbidden",
        });
        expect(
          callGateway.mock.calls.some(
            ([request]) =>
              request.method === "chat.history" || request.method === "sessions.search",
          ),
        ).toBe(false);
      }
      if (kind === "search") {
        callGateway.mockClear();
        expect((await tool.execute("unscoped", { query: "evidence" })).details).toMatchObject({
          results: [{ sessionKey: observed }],
        });
        // A bound read scope already identifies the only searchable session.
        // Listing every active/archived session can exhaust Side chat’s deadline.
        expect(callGateway.mock.calls.map(([request]) => request.method)).not.toContain(
          "sessions.list",
        );
        expect(callGateway).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "sessions.search",
            params: expect.objectContaining({ sessionKeys: [observed] }),
          }),
        );
      }
      expect(config.tools?.sessions?.visibility).toBe("all");
    },
  );
});
