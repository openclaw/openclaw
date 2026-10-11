import { describe, expect, it, type Mock } from "vitest";
import type { createSessionsSendTool } from "./sessions-send-tool.js";

export function registerSessionsSendMaterializationTests(fixture: {
  createTool: typeof createSessionsSendTool;
  prepare: () => void;
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
        fixture.prepare();
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
          expect(fixture.requireDetails(result).status).toBe("accepted");
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
