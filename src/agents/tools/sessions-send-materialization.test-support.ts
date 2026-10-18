import path from "node:path";
import { expect, it, type Mock } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { createSessionsSendTool as CreateSessionsSendTool } from "./sessions-send-tool.js";

export function registerSessionsSendMaterializationTests({
  createTool,
  prepare,
  cleanup,
  agentChannel,
  callGatewayMock,
  inProcessCreationMock,
  requireDetails,
}: {
  createTool: typeof CreateSessionsSendTool;
  prepare: () => Promise<void>;
  cleanup: () => void;
  agentChannel: string;
  callGatewayMock: Mock<(request: { method?: string }) => Promise<unknown>>;
  inProcessCreationMock: Mock<(...args: [unknown, unknown, unknown]) => Promise<unknown>>;
  requireDetails: (result: { details?: unknown }) => Record<string, unknown>;
}) {
  it.each([undefined, "sender"] as const)(
    "materializes an agent main only without sender restrictions (%s)",
    async (source) => {
      await prepare();
      callGatewayMock.mockClear();
      callGatewayMock.mockImplementation(async (request) => {
        if (request.method === "sessions.create") {
          throw new Error("plain sessions.create must not be used for trusted materialization");
        }
        if (request.method === "agent") {
          return { runId: "run-ensure-main", acceptedAt: 1 };
        }
        return {};
      });
      // No callGateway override: exercise trusted in-process materialization.
      const tool = createTool({
        inheritedToolPolicySource: source,
        agentSessionKey: "agent:main:dashboard:req-provenance",
        agentChannel,
      });

      try {
        const result = await tool.execute("call-ensure-main-provenance", {
          sessionKey: "agent:main:main",
          message: "wake up",
          timeoutSeconds: 0,
        });

        if (source === "sender") {
          expect(requireDetails(result)).toMatchObject({
            status: "forbidden",
            error: "This sender may only start hidden helpers of the same agent.",
          });
          expect(inProcessCreationMock).not.toHaveBeenCalled();
          expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
          return;
        }
        expect(requireDetails(result), JSON.stringify(result.details)).toMatchObject({
          status: "accepted",
        });
        expect(inProcessCreationMock).toHaveBeenCalledTimes(1);
        expect(inProcessCreationMock).toHaveBeenCalledWith(
          "sessions.create",
          { key: "agent:main:main", agentId: "main" },
          {
            via: "internal",
            actor: { type: "agent", id: "agent:main:dashboard:req-provenance" },
          },
        );
      } finally {
        cleanup();
      }
    },
  );
}

export function registerSessionsSendFixedOwnerTests({
  createTool: createSessionsSendTool,
  callGatewayMock,
  requireDetails,
  sessionDirs,
}: {
  createTool: typeof CreateSessionsSendTool;
  callGatewayMock: Mock;
  requireDetails: (result: { details?: unknown }) => Record<string, unknown>;
  sessionDirs: { make(): string };
}) {
  it.each([
    { sessionKey: "global", ownKey: "global", mainKey: undefined },
    { sessionKey: "work", ownKey: "agent:research:work", mainKey: "work" },
  ])(
    "authorizes $sessionKey against its persisted fixed-store owner",
    async ({ sessionKey, ownKey, mainKey }) => {
      const config = {
        session: {
          ...(mainKey ? { mainKey } : {}),
          store: path.join(sessionDirs.make(), "sessions.json"),
        },
        agents: {
          ownership: "explicit" as const,
          entries: { ops: {}, research: {} },
        },
        tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" as const } },
      };
      const send = (ownerAgentId: string) =>
        createSessionsSendTool({
          agentId: "research",
          agentSessionKey: `agent:research:${mainKey ?? "main"}`,
          config: {
            ...config,
            agents: {
              ...config.agents,
              defaults: { sessionStore: { agentId: ownerAgentId } },
            },
          },
        }).execute("owner-check", { sessionKey, message: "status?", timeoutSeconds: 0 });

      if (mainKey) {
        callGatewayMock.mockImplementation(async (request: { method?: string }) =>
          request.method === "sessions.resolve" ? { key: sessionKey, agentId: "ops" } : {},
        );
      }
      const denied = requireDetails(await send("ops"));
      expect(denied).toMatchObject({
        status: "forbidden",
        error: expect.stringContaining("Agent-to-agent messaging is disabled"),
      });
      expect(callGatewayMock.mock.calls).not.toContainEqual([
        expect.objectContaining({ method: "agent" }),
      ]);

      await upsertSessionEntryCore(
        { agentId: "research", sessionKey: ownKey, storePath: config.session.store },
        { sessionId: `research-${sessionKey}`, updatedAt: 1 },
      );
      callGatewayMock
        .mockReset()
        .mockImplementation(async (request: { method?: string }) =>
          mainKey && request.method === "sessions.resolve"
            ? { key: sessionKey, agentId: "research" }
            : { runId: `self-${sessionKey}`, acceptedAt: 1 },
        );
      const allowed = requireDetails(await send("research"));
      expect(allowed.status).toBe("accepted");
    },
  );
}
