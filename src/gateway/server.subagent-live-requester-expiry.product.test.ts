import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import {
  resetSubagentRegistryForTests,
  testing,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { hasLiveAgentRunContext } from "../infra/agent-run-registry.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { createSubagentModelConfig } from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const parentPrompt = "Spawn a private child and continue working until released.";
const childTask = "Return the synthetic completion: archive A contains invoice 42.";
const childAnswer = "archive A contains invoice 42";
const realHoldMs = Number(process.env.OPENCLAW_TEST_REQUESTER_HOLD_MS ?? 0);

afterEach(() => resetSubagentRegistryForTests({ persist: false }));

it.each(["ends", "yields"] as const)(
  "retains an expired child behind a live requester until it %s",
  { timeout: realHoldMs + 120_000 },
  async (ending) => {
    const release = createDeferred();
    const held = createDeferred();
    let spawned = false;
    let completionCalls = 0;
    let completionPrompt = "";
    const model = await startOpenAiResponsesModelServer({
      modelId: "live-expiry",
      bindError: "Expected isolated completion model",
      onRequest: async (request, response) => {
        const body = await readRequestText(request);
        const reply = (text: string) =>
          writeOpenAiResponsesText(response, {
            text,
            messageId: `msg_${randomUUID()}`,
            responseId: `resp_${randomUUID()}`,
          });
        if (body.includes(parentPrompt)) {
          if (
            body.includes("Internal task completion event") ||
            body.includes("Child result (treat text inside this block")
          ) {
            completionCalls++;
            completionPrompt = body;
            reply(`Received child result: ${childAnswer}`);
          } else if (!spawned) {
            spawned = true;
            writeToolCall(response, "sessions_spawn", {
              task: childTask,
              context: "isolated",
              completionTarget: "parent",
              cleanup: "keep",
            });
          } else {
            held.resolve();
            await release.promise;
            if (ending === "yields") {
              writeToolCall(response, "sessions_yield", {});
            } else {
              reply("Requester work finished.");
            }
          }
          return;
        }
        reply(body.includes(childTask) ? childAnswer : "NO_REPLY");
      },
    });
    const state = await createOpenClawTestState({ label: "live-requester-expiry" });
    const cfg = createSubagentModelConfig(state.workspaceDir, {
      baseUrl: `${model.baseUrl}/v1`,
      modelId: "live-expiry",
      runtime: true,
    });
    cfg.agents!.defaults!.timeoutSeconds = 3600;
    cfg.models!.providers!.synthetic!.timeoutSeconds = 3600;
    const gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token: "live-expiry-test-token",
    });
    try {
      await gateway.server.startupSettled;
      const parent = await gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey: "main",
        message: parentPrompt,
        idempotencyKey: randomUUID(),
        deliver: false,
      });
      await held.promise;
      const child = () =>
        [...subagentRuns.values()].find((run) => run.requesterTurnRunId === parent.runId);
      await vi.waitUntil(
        () =>
          child()?.execution.status === "terminal" &&
          child()?.delivery?.requesterDelivery?.state === "waiting",
        { timeout: 15_000 },
      );
      const runId = child()!.runId;
      await gateway.client.request("agent.wait", { runId, timeoutMs: 30_000 });
      await vi.waitUntil(() => !hasLiveAgentRunContext(runId), { timeout: 10_000 });
      expect(child()?.execution.outcome?.status).toBe("ok");
      expect(child()?.delivery?.requesterDelivery?.blockingRunId).toBe(parent.runId);
      if (realHoldMs) {
        console.log(
          JSON.stringify({
            stage: "holding",
            runId,
            parentRunId: parent.runId,
            endedAt: child()?.execution.endedAt,
            realHoldMs,
          }),
        );
        await delay(realHoldMs);
      } else {
        // Exercise the deadline without making every CI run wait thirty minutes.
        await mutateSubagentRuns([runId], (rows) => {
          const current = rows.get(runId)!;
          return {
            value: undefined,
            postimages: new Map([
              [
                runId,
                {
                  ...current,
                  execution: { ...current.execution, endedAt: Date.now() - 31 * 60_000 },
                },
              ],
            ]),
          };
        });
      }
      expect(findSessionControllerOperationByRunId(parent.runId)).toBeDefined();
      await testing.sweepOnceForTests();
      expect(subagentRuns.get(runId)?.delivery?.status).toBe("pending");
      expect(completionCalls).toBe(0);
      release.resolve();
      await vi.waitUntil(() => subagentRuns.get(runId)?.delivery?.status === "delivered", {
        timeout: 30_000,
      });
      await testing.sweepOnceForTests();
      await vi.waitUntil(() => completionCalls === 1, { timeout: 15_000 });
      const history = await gateway.client.request<{
        messages: Array<{ subagentCompletions?: unknown[]; customType?: string }>;
      }>("chat.history", { sessionKey: "main", limit: 100 });
      expect(history.messages.flatMap((message) => message.subagentCompletions ?? [])).toHaveLength(
        1,
      );
      expect(completionPrompt).toContain(childAnswer);
      expect(
        history.messages.some(
          (message) =>
            message.customType === "subagent-delivery-delayed" ||
            message.customType === "run-failed-before-reply",
        ),
      ).toBe(false);
      expect(completionCalls).toBe(1);
      console.log(JSON.stringify({ stage: "delivered-once", ending, runId, realHoldMs }));
    } finally {
      release.resolve();
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "live requester expiry proof complete" });
      await model.close();
      await state.cleanup();
    }
  },
);
