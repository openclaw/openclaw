import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { isTruthyEnvValue } from "../../infra/env.js";
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
    "keeps five alternating peer replies visible after a nonblocking send",
    async () => {
      await runWithLiveSubagentGateway(
        { additionalTools: ["sessions_send"], peerSessions: true },
        async ({ gateway, gates, start, record }) => {
          const id = randomUUID().replaceAll("-", "");
          const parentKey = `agent:main:dashboard:live-peer-requester-${id}`;
          const peerKey = `agent:main:dashboard:live-peer-target-${id}`;
          const waiting = `WAITING_${id}`;
          const prefix = `PEER_${id}_`;
          const gate = gates.create();
          const replyRule = [
            `When a later agent-to-agent reply step delivers ${prefix} followed by an integer, reply with the same prefix and that integer plus one, with no other text.`,
            "The Gateway forwards these final replies automatically. Do not call tools during reply steps or stop the exchange early.",
            "When the current system instructions request the agent-to-agent announce step, reply exactly ANNOUNCE_SKIP. No external announcement is wanted.",
          ].join(" ");
          const peerTask = `${gateTask(gate.url)} After this initial retrieval, follow these rules for later turns: ${replyRule}`;
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
                replyRule,
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

            gate.release(`${prefix}0`);
            await until(
              "five peer reply turns reach the final announce step",
              async () => finalReplies(await history(peerKey), "ANNOUNCE_SKIP")[0],
            );
            for (const [sessionKey, sourceKey, expectedReplies, incoming] of [
              [parentKey, peerKey, [waiting, `${prefix}1`, `${prefix}3`, `${prefix}5`], [0, 2, 4]],
              [
                peerKey,
                parentKey,
                [`${prefix}0`, `${prefix}2`, `${prefix}4`, "ANNOUNCE_SKIP"],
                [1, 3],
              ],
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
              record("peer-exchange-observed", {
                sessionKey,
                replies: finalReplies(messages, ""),
                visibleOwnReplies,
                projectedMessages: visible,
              });
              expect(finalReplies(messages, ""), "exactly five alternating replies").toEqual(
                expectedReplies,
              );
              expect(visibleOwnReplies, "peer answers remain visible").toEqual(
                expectedReplies.filter((reply) => reply !== "ANNOUNCE_SKIP"),
              );
              const peerInputs = messages.filter(
                (message) => message.role === "user" && isForwardedPeerMessage(message),
              );
              expect(peerInputs).toHaveLength(incoming.length + (sessionKey === peerKey ? 1 : 0));
              expect(visiblePeerInputs, "every peer input remains visible").toHaveLength(
                peerInputs.length,
              );
              for (const input of [...peerInputs, ...visiblePeerInputs]) {
                expect(input.provenance).toMatchObject({
                  kind: "inter_session",
                  sourceSessionKey: sourceKey,
                  sourceTool: "sessions_send",
                });
                expect(asOptionalRecord(input.provenance)?.sourceRole).toBeUndefined();
              }
              for (const input of visiblePeerInputs) {
                expect(input).toMatchObject({
                  role: "assistant",
                  senderSession: { sessionKey: sourceKey },
                });
              }
              for (const turn of incoming) {
                const input = peerInputs.filter((message) =>
                  JSON.stringify(message.content).includes(`${prefix}${turn}`),
                );
                expect(input, "each preceding reply is delivered once").toHaveLength(1);
                expect(
                  visiblePeerInputs.filter((message) =>
                    JSON.stringify(message.content).includes(`${prefix}${turn}`),
                  ),
                  "peer input remains visible",
                ).toHaveLength(1);
              }
              expect(
                messages.filter(
                  (message) =>
                    message.role === "toolResult" && message.toolName === "sessions_send",
                ),
                "the Gateway forwards replies without another model messaging call",
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
