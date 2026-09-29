import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applySessionStoreProjection } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

const observed = "agent:main:observed";
const internal = "agent:main:internal-session-effects:companion";
const sibling = "agent:main:unrelated";
const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: { sessions: { visibility: "all" } },
};

function createReadGateway(listedKeys?: string[]) {
  return vi.fn(async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
    const params = request.params as { key?: string; sessionKeys?: string[] } | undefined;
    if (request.method === "sessions.resolve") {
      return { key: params?.key, agentId: "main" };
    }
    if (request.method === "sessions.list" && listedKeys) {
      return {
        sessions: listedKeys.map((key) => ({ key, agentId: "main" })),
      };
    }
    if (request.method === "sessions.search") {
      return {
        results: (params?.sessionKeys ?? []).map((sessionKey) => ({
          sessionKey,
          role: "assistant",
          snippet: "evidence",
          timestamp: 1,
          score: 1,
        })),
      };
    }
    if (request.method === "chat.history") {
      return { messages: [{ role: "assistant", content: "evidence" }] };
    }
    throw new Error("Unexpected Gateway method: " + request.method);
  });
}

describe("host-bound session read scope", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.each(["history", "search"] as const)(
    "reads only the observed session through %s",
    async (kind) => {
      const callGateway = createReadGateway([observed, internal, sibling]);
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
          : { results: [{ sessionKey: observed, snippet: "evidence" }] },
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

  it.each([
    { kind: "history", grantMode: "sync" },
    { kind: "search", grantMode: "async" },
  ] as const)(
    "keeps an observed session's active $grantMode plugin grant inside the $kind read cap",
    async ({ kind, grantMode }) => {
      const discussion = "agent:main:clickclack:discussion";
      const attached = "agent:main:main";
      const expectedSessionId = "attached-incarnation";
      const storePath = path.join(tempDirs.make("side-chat-read-cap-"), "sessions.sqlite");
      await applySessionStoreProjection({
        storePath,
        skipMaintenance: true,
        update: (store) => {
          store[discussion] = { sessionId: "discussion-incarnation", updatedAt: 1 };
          store[attached] = { sessionId: expectedSessionId, updatedAt: 1 };
          return { persist: true, result: undefined };
        },
      });
      const callGateway = createReadGateway();
      const create = (scoped: boolean) => {
        const opts = {
          agentId: "main",
          agentSessionKey: scoped ? internal : discussion,
          sessionReadScopeKey: scoped ? discussion : undefined,
          config: {
            ...config,
            session: { store: storePath },
            tools: { sessions: { visibility: "self" as const } },
          },
          callGateway: callGateway as AgentToolGatewayRequestCaller,
        };
        return kind === "history"
          ? createSessionsHistoryTool(opts)
          : createSessionsSearchTool(opts);
      };
      const args = kind === "history" ? {} : { query: "evidence" };
      expect(
        (await create(false).execute("no-grant", { ...args, sessionKey: attached })).details,
      ).toMatchObject({ status: "forbidden" });
      const resolveGrant = vi.fn<
        Parameters<typeof createSessionVisibilityChecker.registerScopedAccessProvider>[0]
      >((request) =>
        request.requesterSessionKey === discussion && request.targetSessionKey === attached
          ? { expectedSessionId }
          : undefined,
      );
      const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(
        grantMode === "async" ? () => undefined : resolveGrant,
        grantMode === "async"
          ? { resolveAsync: async (request) => resolveGrant(request) }
          : undefined,
      );
      try {
        // The grant is valid for the discussion itself, even under self visibility.
        expect(
          (await create(false).execute("ordinary-grant", { ...args, sessionKey: attached }))
            .details,
        ).toMatchObject(
          kind === "history"
            ? { sessionKey: attached, messages: [{ role: "assistant", content: "evidence" }] }
            : { results: [{ sessionKey: attached, snippet: "evidence" }] },
        );
        callGateway.mockClear();
        const scoped = create(true);
        expect(
          (await scoped.execute("selected", { ...args, sessionKey: discussion })).details,
        ).toMatchObject(
          kind === "history"
            ? { sessionKey: discussion, messages: [{ role: "assistant", content: "evidence" }] }
            : { results: [{ sessionKey: discussion, snippet: "evidence" }] },
        );
        callGateway.mockClear();
        resolveGrant.mockClear();
        expect(
          (await scoped.execute("outside-cap", { ...args, sessionKey: attached })).details,
        ).toMatchObject({ status: "forbidden" });
        expect(resolveGrant).not.toHaveBeenCalled();
        expect(
          callGateway.mock.calls.some(
            ([request]) =>
              request.method === "chat.history" || request.method === "sessions.search",
          ),
        ).toBe(false);
      } finally {
        unregister();
      }
    },
  );
});
