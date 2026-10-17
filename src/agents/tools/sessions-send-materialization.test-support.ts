import path from "node:path";
import { describe, expect, it, type Mock } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { createSessionsSendTool as CreateSessionsSendTool } from "./sessions-send-tool.js";

export function registerSessionsSendMaterializationTests(fixture: {
  createTool: typeof CreateSessionsSendTool;
  prepare: () => Promise<void>;
  cleanup: () => void;
  agentChannel: string;
  callGatewayMock: Mock<(request: { method?: string }) => Promise<unknown>>;
  inProcessCreationMock: Mock<(...args: [unknown, unknown, unknown]) => Promise<unknown>>;
  requireDetails: (result: { details?: unknown }) => Record<string, unknown>;
}) {
  describe("sessions_send agent-main materialization provenance", () => {
    it.each([undefined, "sender"] as const)(
      "materializes an agent main only without sender restrictions (%s)",
      async (source) => {
        await fixture.prepare();
        fixture.callGatewayMock.mockClear();
        fixture.callGatewayMock.mockImplementation(async (request) => {
          if (request.method === "sessions.resolve") {
            return {};
          }
          if (request.method === "sessions.create") {
            throw new Error("plain sessions.create must not be used for trusted materialization");
          }
          if (request.method === "agent") {
            return { runId: "run-ensure-main", acceptedAt: 1 };
          }
          return {};
        });
        // Mirror production assembly: no callGateway override, so materialization
        // takes the trusted in-process branch.
        const tool = fixture.createTool({
          inheritedToolPolicySource: source,
          agentSessionKey: "agent:main:dashboard:req-provenance",
          agentChannel: fixture.agentChannel,
        });

        try {
          const result = await tool.execute("call-ensure-main-provenance", {
            sessionKey: "agent:main:main",
            message: "wake up",
            timeoutSeconds: 0,
          });

          if (source === "sender") {
            expect(fixture.requireDetails(result)).toMatchObject({
              status: "forbidden",
              error: "This sender may only start hidden helpers of the same agent.",
            });
            expect(fixture.inProcessCreationMock).not.toHaveBeenCalled();
            expect(
              fixture.callGatewayMock.mock.calls.some(([call]) => call.method === "agent"),
            ).toBe(false);
            return;
          }
          expect(fixture.requireDetails(result), JSON.stringify(result.details)).toMatchObject({
            status: "accepted",
          });
          expect(fixture.inProcessCreationMock).toHaveBeenCalledTimes(1);
          expect(fixture.inProcessCreationMock).toHaveBeenCalledWith(
            "sessions.create",
            { key: "agent:main:main", agentId: "main" },
            {
              via: "internal",
              actor: { type: "agent", id: "agent:main:dashboard:req-provenance" },
            },
          );
        } finally {
          fixture.cleanup();
        }
      },
    );
  });
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
  it("authorizes literal sentinels against their persisted fixed-store owner", async () => {
    const config = {
      session: { store: path.join(sessionDirs.make(), "sessions.json") },
      agents: {
        ownership: "explicit" as const,
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
      tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" as const } },
    };
    const createTool = (ownerAgentId: string) =>
      createSessionsSendTool({
        agentId: "research",
        agentSessionKey: "agent:research:main",
        config: {
          ...config,
          agents: {
            ...config.agents,
            defaults: { sessionStore: { agentId: ownerAgentId } },
          },
        },
      });

    const denied = requireDetails(
      await createTool("ops").execute("foreign-global", {
        sessionKey: "global",
        message: "status?",
        timeoutSeconds: 0,
      }),
    );
    expect(denied).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("Agent-to-agent messaging is disabled"),
    });
    expect(callGatewayMock.mock.calls).not.toContainEqual([
      expect.objectContaining({ method: "agent" }),
    ]);

    await upsertSessionEntryCore(
      { agentId: "research", sessionKey: "global", storePath: config.session.store },
      { sessionId: "research-global", updatedAt: 1 },
    );
    callGatewayMock.mockReset().mockResolvedValue({ runId: "self-global", acceptedAt: 1 });
    const allowed = requireDetails(
      await createTool("research").execute("self-global", {
        sessionKey: "global",
        message: "note",
        timeoutSeconds: 0,
      }),
    );
    expect(allowed.status).toBe("accepted");
  });

  it("authorizes a custom main alias against its persisted fixed-store owner", async () => {
    const config = {
      session: { mainKey: "work", store: path.join(sessionDirs.make(), "sessions.json") },
      agents: {
        ownership: "explicit" as const,
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
      tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" as const } },
    };
    const createTool = (ownerAgentId: string) =>
      createSessionsSendTool({
        agentId: "research",
        agentSessionKey: "agent:research:work",
        config: {
          ...config,
          agents: {
            ...config.agents,
            defaults: { sessionStore: { agentId: ownerAgentId } },
          },
        },
      });

    callGatewayMock.mockImplementation(async (request: { method?: string }) =>
      request.method === "sessions.resolve" ? { key: "work", agentId: "ops" } : {},
    );
    expect(
      requireDetails(
        await createTool("ops").execute("foreign-work", {
          sessionKey: "work",
          message: "status?",
          timeoutSeconds: 0,
        }),
      ),
    ).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("Agent-to-agent messaging is disabled"),
    });

    await upsertSessionEntryCore(
      { agentId: "research", sessionKey: "agent:research:work", storePath: config.session.store },
      { sessionId: "research-work", updatedAt: 1 },
    );
    callGatewayMock
      .mockReset()
      .mockImplementation(async (request: { method?: string }) =>
        request.method === "sessions.resolve"
          ? { key: "work", agentId: "research" }
          : { runId: "self-work", acceptedAt: 1 },
      );
    const allowed = requireDetails(
      await createTool("research").execute("self-work", {
        sessionKey: "work",
        message: "note",
        timeoutSeconds: 0,
      }),
    );
    expect(allowed.status, JSON.stringify(allowed)).toBe("accepted");
  });
}
