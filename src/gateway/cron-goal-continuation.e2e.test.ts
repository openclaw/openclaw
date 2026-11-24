import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

it.each([false, true])(
  "settles a named automation without admitting a Goal turn on its behalf (rearm=%s)",
  { timeout: 90_000 },
  async (rearm) => {
    await withOpenClawTestState(kernelGatewayTestStateOptions("cron-goal"), async () => {
      let modelCalls = 0;
      let resuming = false;
      const fixture = createChatFixture("cron-goal", {
        configure: (config) => {
          if (rearm) {
            setTestEnvValue("OPENCLAW_SKIP_CRON", "0");
          }
          return {
            ...config,
            plugins: { slots: { memory: "none" } },
            tools: {
              profile: "coding",
              alsoAllow: [AUTOMATIONS_TOOL_NAME],
              codeMode: false,
              toolSearch: false,
            },
            cron: { enabled: rearm, triggers: { enabled: false } },
          };
        },
        respond: async (body, _sessionId, response) => {
          if (body.includes("conversationLabelSource")) {
            return "Audit";
          }
          modelCalls += 1;
          if (rearm && modelCalls === 1) {
            expect(body).toContain('"name":"automations"');
            writeToolCall(response, AUTOMATIONS_TOOL_NAME, { action: "next_check", in: "2s" });
            return;
          }
          if (resuming) {
            if (modelCalls === 2) {
              return "The audit has one item left.";
            }
            if (modelCalls === 3) {
              expect(body).toContain("Advance the active goal");
              writeToolCall(response, "update_goal", { status: "complete" });
              return;
            }
            expect(modelCalls).toBe(4);
            return "Finished the audit after Resume.";
          }
          return "Saved the audit checkpoint.";
        },
      });
      await runQaGatewayFixture(
        async () => {
          await fixture.start();
          const { key: sessionKey } = await fixture.client.request<{ key: string }>(
            "sessions.create",
            {
              agentId: "main",
            },
          );
          const target = { agentId: "main", sessionKey };
          const session = loadSessionEntry(target)!;
          const now = Date.now();
          const goalId = randomUUID();
          await replaceSessionEntry(target, {
            ...session,
            goal: {
              schemaVersion: 1,
              id: goalId,
              status: "active",
              objective: "Finish the audit.",
              createdAt: now,
              updatedAt: now,
              tokenStart: 0,
              tokensUsed: 0,
              continuationTurns: 0,
            },
          });
          const { id } = await fixture.client.request<{ id: string }>("cron.add", {
            name: "Audit follow-up",
            agentId: target.agentId,
            ...(rearm ? { deleteAfterRun: true } : {}),
            schedule: rearm
              ? { kind: "at", at: new Date(Date.now() + 1_000).toISOString() }
              : { kind: "every", everyMs: 86_400_000 },
            sessionTarget: "session:" + sessionKey,
            payload: {
              kind: "agentTurn",
              message: "Save the audit checkpoint.",
              toolsAllow: rearm ? [AUTOMATIONS_TOOL_NAME] : [],
            },
            delivery: { mode: "none" },
          });
          if (rearm) {
            const jobs = async () =>
              (
                await fixture.client.request<{ jobs: { id: string }[] }>("cron.list", {
                  includeDisabled: true,
                })
              ).jobs;
            // The timer runs the authored occurrence and its one rearm. No manual run can
            // compensate for a scheduler that never published or fired the new slot.
            await expect
              .poll(async () => (await jobs()).some((job) => job.id === id), { timeout: 45_000 })
              .toBe(false);
          } else {
            expect(
              await fixture.client.request(
                "cron.run",
                { id, mode: "force", waitTimeoutMs: 30_000 },
                { timeoutMs: 35_000 },
              ),
            ).toMatchObject({ enqueued: true });
          }
          const drain = await waitForGatewayActiveWork(30_000);
          expect(drain.drained, JSON.stringify(drain.snapshot.blockers)).toBe(true);
          expect(modelCalls).toBe(rearm ? 3 : 1);

          const history = await fixture.client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey,
          });
          const transcript = JSON.stringify(history.messages);
          expect(transcript).toContain("Saved the audit checkpoint.");
          expect(transcript).not.toContain("cron delivery owner retired");
          expect(loadSessionEntry(target)?.goal).toMatchObject({
            id: goalId,
            status: "active",
            continuationTurns: 0,
          });
          if (!rearm) {
            resuming = true;
            const runId = randomUUID();
            expect(
              await fixture.client.request("sessions.goal.update", {
                ...target,
                sessionId: session.sessionId,
                goalId,
                action: "resume",
                operationId: runId,
                issuedAtMs: Date.now(),
              }),
            ).toMatchObject({ status: "started", runId, goalId });
            expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
            expect(modelCalls).toBe(4);
            expect(loadSessionEntry(target)?.goal).toMatchObject({
              id: goalId,
              status: "complete",
              continuationTurns: 1,
            });
          }
          expect(fixture.errors).toEqual([]);
        },
        () => fixture.close(),
      );
    });
  },
);
