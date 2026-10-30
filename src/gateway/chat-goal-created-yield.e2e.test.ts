import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { getSubagentRunByRunId } from "../agents/subagents/registry/subagent-registry.js";
import * as queueLifecycle from "../auto-reply/reply/queue/lifecycle.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

function records(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      return records(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap(records);
  }
  const record = asOptionalRecord(value);
  return record ? [record, ...Object.values(record).flatMap(records)] : [];
}

// Real Gateway, tools and committed child return. Only provider decisions are scripted.
it(
  "delivers one Goal continuation after direct or queued creation and a delegated or ordinary final",
  {
    timeout: 120_000,
  },
  async ({ signal }) => {
    const scenarios = [
      { name: "delegated", delegated: true, queued: false },
      { name: "direct", delegated: false, queued: false },
      { name: "queued", delegated: true, queued: true },
    ].map(({ name, delegated, queued }) => {
      const nonce = randomUUID();
      return {
        name,
        delegated,
        queued,
        predecessorPrompt: `PREDECESSOR_${nonce}`,
        predecessorCalls: 0,
        predecessorStarted: createDeferredCore(),
        releasePredecessor: createDeferredCore(),
        enqueued: createDeferredCore(),
        finalText: `GOAL_DONE_${nonce}`,
        finalMessages: [] as unknown[],
        finalReceived: createDeferredCore(),
        prompt: `GOAL_CREATE_${nonce}: Create the requested Goal, finish the first item, then continue the remaining item.`,
        childTask: `CHILD_ITEM_${nonce}: Return the first-item finding only.`,
        childResult: `CHILD_DONE_${nonce}`,
        parentCalls: 0,
        childCalls: 0,
        sessionKey: "",
        childRunId: undefined as string | undefined,
        releaseChild: createDeferredCore(),
        childStarted: createDeferredCore(),
        yielded: createDeferredCore(),
        committed: createDeferredCore(),
        failed: createDeferredCore<never>(),
      };
    });
    for (const scenario of scenarios) {
      void scenario.failed.promise.catch(() => {});
    }
    // chat.send acknowledges durable admission before enqueue publication. Observe
    // the real queue decision, without replacing it, before releasing its predecessor.
    const enqueue = queueLifecycle.markFollowupRunEnqueued;
    const observeQueue = vi
      .spyOn(queueLifecycle, "markFollowupRunEnqueued")
      .mockImplementation((run) => {
        const enqueued = enqueue(run);
        if (enqueued) {
          scenarios
            .find((scenario) => scenario.queued && run.prompt.includes(scenario.prompt))
            ?.enqueued.resolve();
        }
        return enqueued;
      });
    onTestFinished(() => observeQueue.mockRestore());
    await withOpenClawTestState(
      {
        label: "goal-created-yield",
        env: {
          ...KERNEL_TEST_ENV,
          VITEST: process.env.VITEST,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async () => {
        const fixture = createChatFixture("goal-created-yield", {
          onEvent: ({ event, payload: value }) => {
            const payload = asOptionalRecord(value);
            const scenario = scenarios.find((entry) => entry.sessionKey === payload?.sessionKey);
            if (
              event === "session.message" &&
              scenario &&
              records(payload?.message).some(
                (part) => part.type === "text" && part.text === scenario.finalText,
              )
            ) {
              scenario.finalMessages.push(payload?.message);
              scenario.finalReceived.resolve();
            }
          },
          configure: (config) => ({
            ...config,
            agents: { ...config.agents, ownership: "explicit", entries: { main: {} } },
            plugins: { slots: { memory: "none" } },
            tools: { profile: "coding", toolSearch: false },
            messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
          }),
          respond: async (body, _sessionId, response) => {
            if (body.includes("conversationLabelSource")) {
              return "Goal test";
            }
            const scenario =
              scenarios.find((candidate) => body.includes(candidate.prompt)) ??
              scenarios.find((candidate) => body.includes(candidate.childTask)) ??
              scenarios.find((candidate) => body.includes(candidate.predecessorPrompt));
            assert(scenario, "only fixture conversations may call this provider");
            try {
              if (
                scenario.queued &&
                body.includes(scenario.predecessorPrompt) &&
                !body.includes(scenario.prompt)
              ) {
                scenario.predecessorCalls++;
                expect(scenario.predecessorCalls).toBe(1);
                scenario.predecessorStarted.resolve();
                await scenario.releasePredecessor.promise;
                return "The predecessor is complete; no Goal was created.";
              }
              if (!body.includes(scenario.prompt) && body.includes(scenario.childTask)) {
                scenario.childCalls++;
                expect(scenario.childCalls).toBe(1);
                scenario.childStarted.resolve();
                await scenario.releaseChild.promise;
                return scenario.childResult;
              }
              scenario.parentCalls++;
              const output = records(JSON.parse(body) as unknown).findLast(
                (record) => record.type === "function_call_output",
              );
              const toolOutput = records(output?.output);
              if (scenario.parentCalls === 1) {
                writeToolCall(response, "create_goal", { objective: scenario.prompt });
              } else if (scenario.parentCalls === 2) {
                expect(toolOutput).toContainEqual(expect.objectContaining({ status: "created" }));
                if (!scenario.delegated) {
                  return "First item done; the remaining item is unfinished.";
                }
                writeToolCall(response, "sessions_spawn", {
                  task: scenario.childTask,
                  agentId: "main",
                  runtime: "subagent",
                  context: "isolated",
                  cleanup: "keep",
                  completionTarget: "parent",
                });
              } else if (scenario.delegated && scenario.parentCalls === 3) {
                const receipt = toolOutput.find(
                  (record) =>
                    typeof record.runId === "string" && typeof record.childSessionKey === "string",
                );
                assert(receipt && typeof receipt.runId === "string", "real spawn receipt required");
                scenario.childRunId = receipt.runId;
                writeToolCall(response, "sessions_yield", {});
              } else if (scenario.delegated && scenario.parentCalls === 4) {
                expect(body).toContain(scenario.childResult);
                expect(body).toContain("Active goal:");
                return "Delegated item done; the remaining item is unfinished.";
              } else if (scenario.parentCalls === (scenario.delegated ? 5 : 3)) {
                expect(body).toContain("Advance the active goal");
                writeToolCall(response, "update_goal", { status: "complete" });
              } else if (scenario.parentCalls === (scenario.delegated ? 6 : 4)) {
                expect(toolOutput).toContainEqual(expect.objectContaining({ status: "updated" }));
                return scenario.finalText;
              } else {
                throw new Error(`Unexpected Goal request ${scenario.parentCalls}`);
              }
              return undefined;
            } catch (error) {
              scenario.failed.reject(error);
              return "Fixture assertion failed; stop this turn.";
            }
          },
        });
        await runQaGatewayFixture(
          async () => {
            await fixture.start();
            for (const scenario of scenarios) {
              const wait = <T>(promise: Promise<T>) =>
                withinTest(Promise.race([promise, scenario.failed.promise]), signal);
              const created = await fixture.client.request<{ key: string }>("sessions.create", {
                agentId: "main",
                label: `Goal ${scenario.name}`,
              });
              scenario.sessionKey = created.key;
              expect(
                await fixture.client.request("sessions.messages.subscribe", {
                  key: scenario.sessionKey,
                }),
              ).toMatchObject({ subscribed: true });
              const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
                const child = scenario.childRunId && getSubagentRunByRunId(scenario.childRunId);
                if (!child) {
                  return;
                }
                if (child.requesterSettleWake?.requesterYieldBatch && !child.requesterTurnRunId) {
                  scenario.yielded.resolve();
                }
                if (child.cleanupCompletedAt !== undefined && !child.requesterSettleWake) {
                  scenario.committed.resolve();
                }
                if (child.delivery?.status === "suspended") {
                  scenario.failed.reject(
                    new Error("Child delivery suspended: " + child.delivery.lastError),
                  );
                }
              });
              try {
                if (scenario.queued) {
                  await fixture.client.request("chat.send", {
                    sessionKey: scenario.sessionKey,
                    message: scenario.predecessorPrompt,
                    idempotencyKey: randomUUID(),
                  });
                  await wait(scenario.predecessorStarted.promise);
                }
                const accepted = await fixture.client.request<{ status: string; runId: string }>(
                  "chat.send",
                  {
                    sessionKey: scenario.sessionKey,
                    message: scenario.prompt,
                    ...(scenario.queued ? { queueMode: "followup" } : {}),
                    idempotencyKey: randomUUID(),
                  },
                );
                expect(accepted.status).toBe("started");
                if (scenario.queued) {
                  await wait(scenario.enqueued.promise);
                  // Observe the second user input queued behind the held predecessor,
                  // before any Goal exists; the later automatic nudge is a distinct turn.
                  expect(
                    await fixture.client.request("chat.history", {
                      sessionKey: scenario.sessionKey,
                      inputRunIds: [accepted.runId],
                    }),
                  ).toMatchObject({
                    inputReceipts: [{ runId: accepted.runId, state: "pending", queued: true }],
                  });
                  expect(
                    loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey })?.goal,
                  ).toBeUndefined();
                  expect(scenario.parentCalls).toBe(0);
                  scenario.releasePredecessor.resolve();
                }
                if (scenario.delegated) {
                  await wait(
                    Promise.all([scenario.childStarted.promise, scenario.yielded.promise]),
                  );
                  expect(scenario.parentCalls).toBe(3);
                  scenario.releaseChild.resolve();
                  await wait(scenario.committed.promise);
                } else {
                  expect(
                    await wait(
                      fixture.client.request("agent.wait", {
                        runId: accepted.runId,
                        timeoutMs: 30_000,
                      }),
                    ),
                  ).toMatchObject({ status: "ok" });
                }
                const drained = await wait(waitForGatewayActiveWork(30_000));
                expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
                expect(
                  loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey })?.goal,
                ).toMatchObject({
                  status: "complete",
                  continuationTurns: 1,
                });
                expect(scenario.parentCalls).toBe(scenario.delegated ? 6 : 4);
                expect(scenario.childCalls).toBe(Number(scenario.delegated));
                expect(scenario.predecessorCalls).toBe(Number(scenario.queued));
                await wait(scenario.finalReceived.promise);
                const finalMessage = expect.objectContaining({
                  role: "assistant",
                  content: [expect.objectContaining({ type: "text", text: scenario.finalText })],
                });
                expect(scenario.finalMessages).toEqual([finalMessage]);
                const history = await fixture.client.request<{ messages: unknown[] }>(
                  "chat.history",
                  { sessionKey: scenario.sessionKey, limit: 100 },
                );
                expect(
                  history.messages.filter((message) =>
                    records(message).some(
                      (part) => part.type === "text" && part.text === scenario.finalText,
                    ),
                  ),
                ).toEqual([finalMessage]);
                expect(fixture.errors).toEqual([]);
              } finally {
                scenario.releasePredecessor.resolve();
                scenario.releaseChild.resolve();
                unsubscribe();
              }
            }
          },
          async () => {
            for (const scenario of scenarios) {
              scenario.releasePredecessor.resolve();
              scenario.releaseChild.resolve();
            }
            await fixture.close();
          },
        );
      },
    );
  },
);
