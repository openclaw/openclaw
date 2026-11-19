import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { getActiveGatewayRootWorkHolders } from "../../process/gateway-work-admission.js";
import { isLiveTestEnabled } from "../live-test-helpers.js";
import {
  finalReplies,
  gateTask,
  history,
  runWithLiveSubagentGateway,
  until,
} from "../subagents/announce/subagent-challenges.live.test-support.js";

const enabled = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_SUBAGENT_STRESS);
const describeLive = enabled ? describe : describe.skip;

function isForwardedPeerMessage(message: Record<string, unknown>): boolean {
  const provenance = asOptionalRecord(message.provenance);
  return provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send";
}

describeLive("OpenAI independent peer coordination", () => {
  it(
    "delivers a delayed peer reply to the requester exactly once without automatic peer turns",
    async () => {
      await runWithLiveSubagentGateway(
        { additionalTools: ["sessions_send"], peerSessions: true },
        async ({ gateway, gates, start, record }) => {
          const id = randomUUID().replaceAll("-", "");
          const parentKey = `agent:main:dashboard:live-peer-requester-${id}`;
          const peerKey = `agent:main:dashboard:live-peer-target-${id}`;
          const waiting = `WAITING_${id}`;
          const peerReply = `PEER_RESULT_${id}`;
          const received = `RECEIVED_${id}`;
          const gate = gates.create();
          const peerTask = gateTask(gate.url);
          await gateway.request("sessions.create", { key: peerKey, agentId: "main" });
          const peer = loadSessionEntry({ agentId: "main", sessionKey: peerKey });
          expect(peer).toMatchObject({ spawnDepth: 0 });
          expect(peer?.spawnedBy).toBeUndefined();

          try {
            const initial = await start(
              parentKey,
              [
                `Call sessions_send exactly once with ${JSON.stringify({ sessionKey: peerKey, message: peerTask, timeoutSeconds: 0 })}.`,
                `After acceptance finish this turn with exactly ${waiting}. Do not wait, yield, spawn, inspect files, or call any other tools.`,
                `When the peer result ${peerReply} arrives later, finish with exactly ${received}. Do not call tools or send another message.`,
              ].join("\n"),
            );
            await until("independent peer request reaches the closed gate", () =>
              gate.snapshot().waiting === 1 ? true : undefined,
            );
            const initialOutcome = await until(
              "requester finishes before the peer reply",
              async () => {
                const outcome = await gateway.request<{ status: string }>("agent.wait", {
                  runId: initial.runId,
                  timeoutMs: 1000,
                });
                return outcome.status === "ok" || outcome.status === "error" ? outcome : undefined;
              },
            );
            expect(initialOutcome.status).toBe("ok");
            const before = await history(parentKey);
            expect(finalReplies(before, "")).toEqual([waiting]);
            const sends = before.filter(
              (message) => message.role === "toolResult" && message.toolName === "sessions_send",
            );
            expect(sends).toHaveLength(1);
            expect(sends[0]?.details).toMatchObject({
              status: "accepted",
              targetDisposition: "queued",
              delivery: { status: "pending" },
            });
            expect(gate.snapshot()).toEqual({ requests: 1, waiting: 1, released: false });
            record("peer-held", { parentKey, peerKey, gate: gate.snapshot() });

            gate.release(peerReply);
            await until(
              "the requester receives the delayed peer reply",
              async () => finalReplies(await history(parentKey), received)[0],
            );
            await until("the accepted peer delivery settles", () =>
              getActiveGatewayRootWorkHolders().some((origin) => origin === "session:a2a-send")
                ? undefined
                : true,
            );
            for (const [sessionKey, sourceKey, expectedReplies] of [
              [parentKey, peerKey, [waiting, received]],
              [peerKey, parentKey, [peerReply]],
            ] as const) {
              const messages = await history(sessionKey);
              const projected = await gateway.request<{ messages: unknown[] }>("chat.history", {
                sessionKey,
                limit: 80,
              });
              const visible = projected.messages.flatMap((value) => {
                const message = asOptionalRecord(value);
                return message ? [message] : [];
              });
              const visiblePeerInputs = visible.filter(isForwardedPeerMessage);
              const visibleOwnReplies = finalReplies(
                visible.filter((message) => !isForwardedPeerMessage(message)),
                "",
              );
              record("peer-delivery-observed", {
                sessionKey,
                replies: finalReplies(messages, ""),
                visibleOwnReplies,
                projectedMessages: visible,
              });
              expect(
                finalReplies(messages, ""),
                "only the requested turn and the single requester result turn run",
              ).toEqual(expectedReplies);
              expect(visibleOwnReplies, "both sessions' answers remain visible").toEqual(
                expectedReplies,
              );
              const peerInputs = messages.filter(
                (message) => message.role === "user" && isForwardedPeerMessage(message),
              );
              expect(peerInputs, "each session receives one inter-session input").toHaveLength(1);
              expect(visiblePeerInputs, "the inter-session input remains visible").toHaveLength(1);
              for (const input of [...peerInputs, ...visiblePeerInputs]) {
                expect(input.provenance).toMatchObject({
                  kind: "inter_session",
                  sourceSessionKey: sourceKey,
                  sourceTool: "sessions_send",
                });
                expect(asOptionalRecord(input.provenance)?.sourceRole).toBeUndefined();
              }
              expect(visiblePeerInputs[0]).toMatchObject({
                role: "assistant",
                senderSession: { sessionKey: sourceKey },
              });
              if (sessionKey === parentKey) {
                expect(JSON.stringify(peerInputs[0]?.content)).toContain(peerReply);
                expect(JSON.stringify(visiblePeerInputs[0]?.content)).toContain(peerReply);
              }
              expect(
                messages.filter(
                  (message) =>
                    message.role === "toolResult" && message.toolName === "sessions_send",
                ),
                "the single accepted send owns the delayed delivery",
              ).toHaveLength(sessionKey === parentKey ? 1 : 0);
            }
            expect(gate.snapshot()).toEqual({ requests: 1, waiting: 0, released: true });
          } finally {
            record("peer-final-observation", {
              parentKey,
              peerKey,
              peerMessages: await history(peerKey),
              gate: gate.snapshot(),
            });
          }
        },
      );
    },
    15 * 60_000,
  );
});
