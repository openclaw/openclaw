import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  REQUESTER,
  PARTICIPANT_SHARED,
  withParticipantSessionToolsFixture,
  withDelayedSessionToolsSteering,
  drainSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";

// These synthetic sessions own no browser tabs or browser cleanup resources.
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

describe("sessions_send steering custody", () => {
  beforeAll(async () => {
    await import("./server-methods/sessions-read.js");
  });
  afterEach(drainSessionToolsFixture);

  it.each(["end", "abort", "replaced run end"] as const)(
    "releases custody on receiver %s when the backend never reports settlement",
    async (ending) => {
      await withParticipantSessionToolsFixture(async ({ cfg, turn, bob }) => {
        expect(await turn.steer(bob)).toMatchObject({ status: "accepted" });
        await withDelayedSessionToolsSteering(
          cfg,
          async (receiver) => {
            const result = await createSessionsSendTool({
              config: cfg,
              agentSessionKey: REQUESTER,
            }).execute("participant-steer", {
              sessionKey: PARTICIPANT_SHARED,
              user: bob.profileId,
              message: "Accepted guidance whose backend omits settlement",
              mode: "steer",
              timeoutSeconds: 0,
            });
            expect(result.details).toMatchObject({
              status: "accepted",
              targetDisposition: "steered",
            });
            expect(receiver.pendingCount()).toBe(1);
            turn.complete();
            await setImmediate();
            const releases = turn.releaseCounts.get(bob.profileId) ?? 0;
            if (ending === "abort") {
              expect(receiver.abort()).toBe(true);
            } else {
              if (ending === "replaced run end") {
                receiver.replace();
              }
              receiver.end();
            }
            // Join the already-resolved custody continuation, without a timed wait or polling.
            await setImmediate();
            expect(turn.releaseCounts.get(bob.profileId)).toBeGreaterThan(releases);
          },
          { reportSettlement: false },
        );
      });
    },
  );

  it.each(["sender completed", "source revoked", "receiver cancelled"] as const)(
    "settles accepted sessions_send steering after %s",
    async (outcome) => {
      await withParticipantSessionToolsFixture(async ({ cfg, turn, bob }) => {
        expect(await turn.steer(bob)).toMatchObject({ status: "accepted" });
        await withDelayedSessionToolsSteering(cfg, async (receiver) => {
          const result = await createSessionsSendTool({
            config: cfg,
            agentSessionKey: REQUESTER,
            idempotencyKey: "participant-delayed-steer",
          }).execute("participant-steer", {
            sessionKey: PARTICIPANT_SHARED,
            user: bob.profileId,
            message: "Bob's accepted steering survives the sending turn",
            mode: "steer",
            timeoutSeconds: 0,
          });
          expect(result.details).toMatchObject({
            status: "accepted",
            targetDisposition: "steered",
          });
          expect(receiver.pendingCount()).toBe(1);
          turn.complete();
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
              content: expect.stringContaining("Bob's accepted steering survives the sending turn"),
              provenance: { kind: "inter_session", sourceTool: "sessions_send" },
            });
          }
        });
      });
    },
  );
});
import { setImmediate } from "node:timers/promises";
