// Load the runtime before starting the bounded Gateway fixture.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

it(
  "resumes a person's new chat turn in the visible task where they sent it",
  { timeout: 90_000 },
  async ({ signal }) =>
    withOpenClawTestState(kernelGatewayTestStateOptions("visible-chat-restart"), async () => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:kept-task",
        sessionId: randomUUID(),
      };
      const parent = "agent:main:main";
      const oldRun = randomUUID();
      const prompt = "Finish the remaining items in this chat.";
      const answer = "Remaining items accounted for.";
      const reached = createDeferred();
      const restartNotice = "The Gateway restarted while you were working.";
      const fixture = createChatFixture("visible-chat-restart", {
        configure: (cfg) => ({
          ...cfg,
          agents: { defaults: { ...cfg.agents?.defaults, utilityModel: "" } },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
        }),
        async respond(body) {
          if (body.includes(restartNotice)) {
            return answer;
          }
          if (body.includes(prompt)) {
            reached.resolve();
            return undefined; // Keep the actual user turn live until the Gateway stops it.
          }
          throw new Error("Unexpected fixture model request");
        },
      });
      await runQaGatewayFixture(
        async () => {
          await fixture.start();
          await replaceSessionEntry(target, {
            sessionId: target.sessionId,
            updatedAt: Date.now(),
            status: "done",
            displayName: "Retained task chat", // The finished task is already named.
            createdVia: "spawn",
            spawnedBy: parent,
            spawnDepth: 1,
          });
          subagentRuns.set(
            oldRun,
            createSubagentRunRecord({
              runId: oldRun,
              childSessionKey: target.sessionKey,
              childAgentId: target.agentId,
              childSessionIdentity: { sessionId: target.sessionId },
              requesterSessionKey: parent,
              requesterAgentId: target.agentId,
              endedAt: 1,
            }),
          );
          expect(
            await fixture.client.request("chat.send", {
              sessionKey: target.sessionKey,
              message: prompt,
              idempotencyKey: randomUUID(),
            }),
          ).toMatchObject({ status: "started" });
          await withinTest(reached.promise, signal);
          await fixture.restart();
          await vi.waitFor(
            async () => {
              const history = await fixture.client.request<{ messages: unknown[] }>(
                "chat.history",
                { sessionKey: target.sessionKey },
              );
              expect(JSON.stringify(history.messages).includes(answer), "reply in task chat").toBe(
                true,
              );
            },
            { timeout: 10_000 },
          );
          expect(fixture.requests.map((body) => body.includes(restartNotice))).toEqual([
            false,
            true,
          ]);
          const parentHistory = await fixture.client.request<{ messages: unknown[] }>(
            "chat.history",
            { sessionKey: parent },
          );
          expect(JSON.stringify(parentHistory.messages)).not.toContain(answer);
          expect(fixture.errors).toEqual([]);
        },
        () => fixture.close(),
        () => {
          subagentRuns.delete(oldRun);
        },
      );
    }),
);
