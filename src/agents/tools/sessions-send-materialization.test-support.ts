import path from "node:path";
import { expect, it, type Mock } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { createSessionsSendTool as CreateSessionsSendTool } from "./sessions-send-tool.js";

type SendHarness = {
  createTool: typeof CreateSessionsSendTool;
  callGatewayMock: Mock<(request: { method?: string }) => Promise<unknown>>;
  requireDetails: (result: { details?: unknown }) => Record<string, unknown>;
};

export function registerSessionsSendMaterializationTests(
  h: SendHarness & {
    prepare: () => Promise<void>;
    cleanup: () => void;
    agentChannel: string;
    inProcessCreationMock: Mock<(...args: [unknown, unknown, unknown]) => Promise<unknown>>;
  },
) {
  const { callGatewayMock, inProcessCreationMock, requireDetails } = h;
  it.each([undefined, "sender"] as const)(
    "materializes an agent main only without sender restrictions (%s)",
    async (source) => {
      await h.prepare();
      callGatewayMock.mockClear().mockImplementation(async (request) => {
        if (request.method === "sessions.create") {
          throw new Error("plain sessions.create must not be used for trusted materialization");
        }
        return request.method === "agent" ? { runId: "run-ensure-main", acceptedAt: 1 } : {};
      });
      // No callGateway override: exercise trusted in-process materialization.
      const tool = h.createTool({
        inheritedToolPolicySource: source,
        agentSessionKey: "agent:main:dashboard:req-provenance",
        agentChannel: h.agentChannel,
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
        expect(requireDetails(result).status).toBe("accepted");
        expect(inProcessCreationMock).toHaveBeenCalledWith(
          "sessions.create",
          { key: "agent:main:main", agentId: "main" },
          {
            via: "internal",
            actor: { type: "agent", id: "agent:main:dashboard:req-provenance" },
          },
        );
      } finally {
        h.cleanup();
      }
    },
  );
}

export function registerSessionsSendFixedOwnerTests(
  h: SendHarness & {
    sessionDirs: { make(): string };
  },
) {
  const { callGatewayMock, requireDetails, createTool, sessionDirs } = h;
  it.each([
    { sessionKey: "global", ownKey: "global", mainKey: undefined },
    { sessionKey: "work", ownKey: "agent:research:work", mainKey: "work" },
  ])(
    "authorizes $sessionKey against its persisted fixed-store owner",
    async ({ sessionKey, ownKey, mainKey }) => {
      callGatewayMock.mockReset();
      const storePath = path.join(sessionDirs.make(), "sessions.json");
      const send = (ownerAgentId: string) =>
        createTool({
          agentId: "research",
          agentSessionKey: `agent:research:${mainKey ?? "main"}`,
          config: {
            session: { ...(mainKey ? { mainKey } : {}), store: storePath },
            agents: {
              ownership: "explicit",
              entries: { ops: {}, research: {} },
              defaults: { sessionStore: { agentId: ownerAgentId } },
            },
            tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" } },
          },
        }).execute("owner-check", { sessionKey, message: "status?", timeoutSeconds: 0 });

      if (mainKey) {
        callGatewayMock.mockImplementation(async (request: { method?: string }) =>
          request.method === "sessions.resolve" ? { key: sessionKey, agentId: "ops" } : {},
        );
      }
      expect(requireDetails(await send("ops"))).toMatchObject({
        status: "forbidden",
        error: expect.stringContaining("Agent-to-agent messaging is disabled"),
      });
      expect(callGatewayMock.mock.calls).not.toContainEqual([
        expect.objectContaining({ method: "agent" }),
      ]);

      await upsertSessionEntryCore(
        { agentId: "research", sessionKey: ownKey, storePath },
        { sessionId: `research-${sessionKey}`, updatedAt: 1 },
      );
      callGatewayMock
        .mockReset()
        .mockImplementation(async (request: { method?: string }) =>
          mainKey && request.method === "sessions.resolve"
            ? { key: sessionKey, agentId: "research" }
            : { runId: `self-${sessionKey}`, acceptedAt: 1 },
        );
      expect(requireDetails(await send("research")).status).toBe("accepted");
    },
  );
}
