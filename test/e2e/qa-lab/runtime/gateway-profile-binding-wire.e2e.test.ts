import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import { startHeldResponsesProvider } from "./held-responses-provider.js";
import { wireMessageText } from "./paired-node-worker-wire-fixture.js";
import { runProfileWireProof } from "./profile-binding-wire-fixture.js";
import { SKILL_LIBRARY_ALICE, SkillLibraryWireClient } from "./skill-library-wire-fixture.js";

const REQUEST_TIMEOUT_MS = 30_000;
const CUSTODY_REPLY = "PROFILE-AGENT-CUSTODY-OK";
type Self = { profile: { id: string } };
type HistoryMessage = { role?: string; content?: unknown };

async function history(client: SkillLibraryWireClient, sessionKey: string) {
  return (
    await client.request<{ messages: HistoryMessage[] }>("chat.history", {
      sessionKey,
      limit: 100,
    })
  ).messages;
}

async function expectOpenClawRuntime(client: SkillLibraryWireClient, key: string) {
  await expect(client.request("sessions.describe", { key })).resolves.toMatchObject({
    session: { key, agentRuntime: { id: "openclaw" } },
  });
}

async function expectMismatch(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({
    error: {
      code: "INVALID_REQUEST",
      details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
    },
  });
}

describe("profile binding through an authenticated child Gateway", () => {
  it(
    "fences rejected tool effects before and after a real profile merge on the original socket",
    { timeout: 240_000 },
    async () => {
      await runProfileWireProof(
        () => startQaMockOpenAiServer({ modelRefs: [MODEL_REF] }),
        async ({ instance, provider, admin, alice, aliceId, bobId, createSession }) => {
          const key = await createSession("effects");
          const journal = async (): Promise<MockOpenAiRequestSnapshot[]> => {
            const response = await fetch(`${provider.baseUrl}/debug/requests?after=0`, {
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            expect(response.ok).toBe(true);
            return await response.json();
          };
          const turn = (marker: string) => {
            const sentinel = path.join(instance.state.workspaceDir, `${marker}.txt`);
            const command = `printf '%s' ${JSON.stringify(marker)} >> ${JSON.stringify(sentinel)}`;
            return {
              sentinel,
              command,
              params: {
                sessionKey: key,
                message: [
                  "Tool progress QA check.",
                  `Call the exec tool exactly once with this exact command before answering: \`${command}\`.`,
                  `Reply exactly \`${marker}\`.`,
                ].join(" "),
                deliver: false,
                idempotencyKey: marker,
              },
            };
          };
          const rejectTurn = async (marker: string, expectedProfileId: string) => {
            const rejected = turn(marker);
            const original = "UNCHANGED";
            await fs.writeFile(rejected.sentinel, original);
            const beforeHistory = await history(alice, key);
            const beforeJournal = await journal();
            await expectMismatch(
              alice.request("chat.send", rejected.params, REQUEST_TIMEOUT_MS, {
                expectedProfileId,
              }),
            );
            expect(await history(alice, key)).toEqual(beforeHistory);
            expect(await journal()).toEqual(beforeJournal);
            const unchanged = async () => {
              expect(await fs.readFile(rejected.sentinel, "utf8")).toBe(original);
              expect(
                (await history(alice, key)).filter((message) =>
                  wireMessageText(message).includes(marker),
                ),
              ).toEqual([]);
              expect((await journal()).filter((request) => request.raw.includes(marker))).toEqual(
                [],
              );
            };
            await unchanged();
            return unchanged;
          };
          const allowedTurn = async (marker: string, expectedProfileId?: string) => {
            const allowed = turn(marker);
            await expect(
              alice.request("chat.send", allowed.params, REQUEST_TIMEOUT_MS, {
                expectedProfileId,
              }),
            ).resolves.toMatchObject({ runId: marker, status: "started" });
            await expect(
              alice.request(
                "agent.wait",
                { runId: marker, timeoutMs: PROOF_TIMEOUT_MS },
                PROOF_TIMEOUT_MS + 5_000,
              ),
            ).resolves.toMatchObject({ status: "ok" });
            await vi.waitFor(
              async () => {
                const replies = (await history(alice, key)).filter(
                  (message) => message.role === "assistant" && wireMessageText(message) === marker,
                );
                expect(replies).toHaveLength(1);
              },
              { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
            );
            expect(await fs.readFile(allowed.sentinel, "utf8")).toBe(marker);
            const requests = (await journal()).filter((request) => request.prompt.includes(marker));
            expect(
              requests.some(
                (request) =>
                  request.plannedToolName === "exec" &&
                  request.plannedToolArgs?.command === allowed.command,
              ),
            ).toBe(true);
            expect(
              requests.some(
                (request) =>
                  request.requestKind === "tool-continuation" && request.outcome === "success",
              ),
            ).toBe(true);
            await expectOpenClawRuntime(alice, key);
          };

          const unchangedWrongAccount = await rejectTurn("PROFILE-WRONG-ACCOUNT", bobId);
          await allowedTurn("PROFILE-BOUND-ALLOWED", aliceId);
          await allowedTurn("PROFILE-OMITTED-ALLOWED");
          await unchangedWrongAccount();
          await admin.request("users.linkEmail", {
            email: SKILL_LIBRARY_ALICE,
            targetProfileId: bobId,
          });
          await expect(alice.request<Self>("users.self", {})).resolves.toMatchObject({
            profile: { id: bobId },
          });
          const unchangedOldSelection = await rejectTurn("PROFILE-STALE-SELECTION", aliceId);
          await allowedTurn("PROFILE-MERGED-ALLOWED", bobId);
          // Check again after later successful work so deferred execution cannot pass unnoticed.
          await unchangedWrongAccount();
          await unchangedOldSelection();
        },
      );
    },
  );

  it(
    "retains accepted agent custody across reconnect and rejects a mismatched profile binding",
    { timeout: 180_000 },
    async () => {
      await runProfileWireProof(
        () => startHeldResponsesProvider({ modelRef: MODEL_REF, terminalText: CUSTODY_REPLY }),
        async ({ provider, alice, aliceId, bobId, reconnectAlice, createSession }) => {
          const key = await createSession("agent-custody");
          const runId = "profile-agent-custody";
          const message = `Return exactly ${CUSTODY_REPLY}.`;
          const params = { sessionKey: key, message, deliver: false, idempotencyKey: runId };
          const binding = { expectedProfileId: aliceId };
          await expect(
            alice.request("agent", params, REQUEST_TIMEOUT_MS, binding),
          ).resolves.toMatchObject({ status: "accepted", runId });
          await vi.waitFor(() => expect(provider.requests).toHaveLength(1), {
            timeout: REQUEST_TIMEOUT_MS,
            interval: 20,
          });
          await vi.waitFor(
            async () => {
              const messages = await history(alice, key);
              expect(messages.map((entry) => entry.role)).toEqual(["user"]);
              expect(wireMessageText(messages[0])).toContain(message);
            },
            { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
          );
          await expectOpenClawRuntime(alice, key);
          const committed = await history(alice, key);
          await alice.close();

          const reconnected = await reconnectAlice();
          await expect(reconnected.request<Self>("users.self", {})).resolves.toMatchObject({
            profile: { id: aliceId },
          });
          // request() generates a fresh wire ID; method, params and idempotency key stay identical.
          await expect(
            reconnected.request("agent", params, REQUEST_TIMEOUT_MS, binding),
          ).resolves.toMatchObject({ status: "in_flight", runId, sessionKey: key });
          await expectMismatch(
            reconnected.request("agent", params, REQUEST_TIMEOUT_MS, {
              expectedProfileId: bobId,
            }),
          );
          expect(provider.requests).toHaveLength(1);
          expect(await history(reconnected, key)).toEqual(committed);
          provider.release();
          await expect(
            reconnected.request(
              "agent.wait",
              { runId, timeoutMs: PROOF_TIMEOUT_MS },
              PROOF_TIMEOUT_MS + 5_000,
            ),
          ).resolves.toMatchObject({ status: "ok", runId });
          await vi.waitFor(
            async () => {
              const messages = await history(reconnected, key);
              expect(messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
              expect(wireMessageText(messages[0])).toContain(message);
              expect(wireMessageText(messages[1])).toBe(CUSTODY_REPLY);
            },
            { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
          );
          const terminalHistory = await history(reconnected, key);
          await expect(
            reconnected.request("agent", params, REQUEST_TIMEOUT_MS, binding),
          ).resolves.toMatchObject({
            status: "ok",
            runId,
            result: { payloads: [{ text: CUSTODY_REPLY }] },
          });
          expect(provider.requests).toHaveLength(1);
          expect(JSON.stringify(provider.requests[0])).toContain(message);
          expect(await history(reconnected, key)).toEqual(terminalHistory);
          await expectOpenClawRuntime(reconnected, key);
        },
      );
    },
  );
});
