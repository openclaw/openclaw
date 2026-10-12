import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  REQUESTER,
  TARGET,
  withSessionToolsFixture,
  PARTICIPANT_SHARED,
  withParticipantSessionToolsFixture,
  withDelayedSessionToolsSteering,
  drainSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { roleClient } from "./session-sharing.test-utils.js";

// These synthetic sessions own no browser tabs or browser cleanup resources.
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

describe("sessions_send steering custody", () => {
  beforeAll(async () => {
    await import("./server-methods/sessions-read.js");
  });
  afterEach(drainSessionToolsFixture);

  it.each([
    ["end", false],
    ["abort", false],
    ["replaced run end", false],
    ["sender completed", true],
    ["source revoked", true],
    ["receiver cancelled", true],
  ] as const)(
    "settles accepted steering custody after %s (backend settlement: %s)",
    async (outcome, reportSettlement) => {
      await withParticipantSessionToolsFixture(async ({ cfg, turn, bob }) => {
        expect(await turn.steer(bob)).toMatchObject({ status: "accepted" });
        await withDelayedSessionToolsSteering(
          cfg,
          async (receiver) => {
            const result = await createSessionsSendTool({
              config: cfg,
              agentSessionKey: REQUESTER,
              ...(reportSettlement ? { idempotencyKey: "participant-delayed-steer" } : {}),
            }).execute("participant-steer", {
              sessionKey: PARTICIPANT_SHARED,
              user: bob.profileId,
              message: reportSettlement
                ? "Bob's accepted steering survives the sending turn"
                : "Accepted guidance whose backend omits settlement",
              mode: "steer",
              timeoutSeconds: 0,
            });
            expect(result.details).toMatchObject({
              status: "accepted",
              targetDisposition: "steered",
            });
            expect(receiver.pendingCount()).toBe(1);
            turn.complete();
            if (!reportSettlement) {
              await setImmediate();
              const releases = turn.releaseCounts.get(bob.profileId) ?? 0;
              if (outcome === "abort") {
                expect(receiver.abort()).toBe(true);
              } else {
                if (outcome === "replaced run end") {
                  receiver.replace();
                }
                receiver.end();
              }
              // Join the already-resolved custody continuation, without a timed wait or polling.
              await setImmediate();
              expect(turn.releaseCounts.get(bob.profileId)).toBeGreaterThan(releases);
              return;
            }
            if (outcome === "source revoked") {
              turn.revoke(bob.profileId);
              await expect(receiver.commit()).rejects.toThrow(/authority|access|revoked/i);
            } else if (outcome === "receiver cancelled") {
              await receiver.cancel();
              expect(receiver.pendingCount()).toBe(0);
            } else {
              await receiver.commit();
              expect(receiver.pendingCount()).toBe(0);
            }
            const messages = (
              await loadTranscriptEvents({
                agentId: "main",
                sessionKey: PARTICIPANT_SHARED,
                sessionId: "participant-shared-id",
              })
            )
              .map(readTranscriptEventMessage)
              .filter((message) => message?.idempotencyKey === "participant-delayed-steer:user");
            expect(messages).toHaveLength(outcome === "sender completed" ? 1 : 0);
            if (outcome === "sender completed") {
              expect(messages[0]).toMatchObject({
                role: "user",
                content: expect.stringContaining(
                  "Bob's accepted steering survives the sending turn",
                ),
                provenance: { kind: "inter_session", sourceTool: "sessions_send" },
              });
            }
          },
          { reportSettlement },
        );
      });
    },
  );
});
import { setImmediate } from "node:timers/promises";

describe("runtime-only session authority", () => {
  beforeAll(async () => {
    await import("./server-methods/chat.js");
  });
  afterEach(drainSessionToolsFixture);

  it("keeps runtime-only session access working without a personal-tool participant registry", async () => {
    await withSessionToolsFixture(async () => {
      const context = getPluginRuntimeGatewayRequestScope()?.context;
      if (!context) {
        throw new Error("expected local Gateway context");
      }
      const caller = {
        agentId: "main",
        sessionKey: REQUESTER,
        operationalRunInstance: { instanceId: "unregistered-instance", runId: "unregistered-run" },
      };
      const delegatedAuthority = claimAgentRunDelegatedAuthority(caller.operationalRunInstance);
      const handle = createEmbeddedRunHandle({ runId: caller.operationalRunInstance.runId });
      const sessionId = "session-tools-requester-id";
      const client = roleClient("write");
      client.internal = {
        syntheticClient: true,
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          ...caller,
          delegatedAuthority: { kind: "local", ...delegatedAuthority },
        },
      };
      try {
        await withGatewayToolCallerIdentity(caller, () =>
          setActiveEmbeddedRun(sessionId, handle, REQUESTER, undefined, "main"),
        );
        await withoutGatewayToolCallerIdentity(async () => {
          const request = async (method: string, params: Record<string, unknown>) => {
            const respond = vi.fn<GatewayRequestOptions["respond"]>();
            await handleGatewayRequest({
              req: { type: "req", id: "unregistered-session-call", method, params },
              context,
              client,
              isWebchatConnect: () => false,
              respond,
            });
            return respond.mock.calls;
          };
          expect(await request("chat.history", { sessionKey: TARGET })).toMatchObject([
            [true, { sessionKey: TARGET, messages: [] }],
          ]);
          expect(await request("agent.wait", { runId: "unknown-run", timeoutMs: 0 })).toMatchObject(
            [[true, { runId: "unknown-run", status: "timeout" }]],
          );
          expect(
            await request("ui.command", { command: { kind: "sidebar", visible: false } }),
          ).toMatchObject([
            [
              false,
              undefined,
              {
                message: expect.stringContaining(
                  "Personal-tool turn authority is no longer active",
                ),
              },
            ],
          ]);
        });
      } finally {
        clearActiveEmbeddedRun(sessionId, handle, REQUESTER);
        releaseAgentRunDelegatedAuthority(delegatedAuthority);
      }
    });
  });
});
