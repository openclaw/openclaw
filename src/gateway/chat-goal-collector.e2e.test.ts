import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  getSubagentRunByRunId,
  listUnsettledRequesterChildren,
} from "../agents/subagents/registry/subagent-registry.js";
import * as spawnRuntime from "../agents/subagents/spawn/subagent-spawn.runtime.js";
import * as goalContinuation from "../auto-reply/reply/goal-continuation.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { PluginInventoryRetiredError } from "../plugins/plugin-instance-error.js";
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

// Real Gateway, tools, collector, registry and queue. Provider decisions are scripted.
// B/C/E inject the typed refusal at spawn model verification: not hot-reload proof.
it(
  "returns Goal custody after collected children, including a refused final launch",
  { timeout: 120_000 },
  async ({ signal }) => {
    const scenarios = [
      { name: "A-collected", collector: true, refuse: false, announce: false, empty: false },
      { name: "B-collected-refused", collector: true, refuse: true, announce: false, empty: false },
      { name: "C-only-refused", collector: false, refuse: true, announce: false, empty: false },
      { name: "D-completion-owner", collector: false, refuse: false, announce: true, empty: false },
      { name: "E-error-payload", collector: true, refuse: true, announce: false, empty: true },
    ].map((spec) =>
      Object.assign(spec, {
        marker: randomUUID(),
        sessionKey: "",
        phase: "create",
        childRunId: "",
        childCalls: 0,
        refused: 0,
        collected: false,
        continuationCalls: 0,
        releaseChild: createDeferredCore(),
        childStarted: createDeferredCore(),
        failed: createDeferredCore<never>(),
        decisions: [] as Array<{
          admitted: boolean;
          stopReason?: string;
          errors: number;
          spawns: number;
          completions: number;
          yielded: boolean;
        }>,
      }),
    );
    for (const scenario of scenarios) {
      void scenario.failed.promise.catch(() => {});
    }
    let refuseNext = false;
    const prepare = spawnRuntime.prepareModelChoice;
    const modelChoice = vi
      .spyOn(spawnRuntime, "prepareModelChoice")
      .mockImplementation((...args) => {
        if (refuseNext) {
          refuseNext = false;
          throw new PluginInventoryRetiredError();
        }
        return prepare(...args);
      });
    const enqueue = goalContinuation.enqueueGoalContinuation;
    const observe = vi
      .spyOn(goalContinuation, "enqueueGoalContinuation")
      .mockImplementation(async (params) => {
        const admitted = await enqueue(params);
        scenarios
          .find((scenario) => scenario.sessionKey === params.sessionKey)
          ?.decisions.push({
            admitted,
            stopReason: params.result.meta.stopReason,
            errors: params.result.payloads?.filter((p) => p.isError).length ?? 0,
            spawns: params.result.acceptedSessionSpawns?.length ?? 0,
            completions:
              params.result.acceptedSessionSpawns?.filter((s) => s.expectsCompletionMessage)
                .length ?? 0,
            yielded: Boolean(params.result.meta.yielded),
          });
        return admitted;
      });
    onTestFinished(() => {
      observe.mockRestore();
      modelChoice.mockRestore();
    });
    await withOpenClawTestState(
      {
        label: "goal-collector",
        env: {
          ...KERNEL_TEST_ENV,
          VITEST: process.env.VITEST,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async () => {
        const fixture = createChatFixture("goal-collector", {
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
            const scenario = scenarios.find((s) => body.includes(s.marker));
            assert(scenario, "only fixture conversations may call the provider");
            try {
              if (!body.includes("PARENT_" + scenario.marker)) {
                scenario.childCalls++;
                scenario.childStarted.resolve();
                if (scenario.announce) {
                  await scenario.releaseChild.promise;
                }
                return "CHILD_DONE_" + scenario.marker;
              }
              const output = records(JSON.parse(body) as unknown).findLast(
                (r) => r.type === "function_call_output",
              );
              const toolOutput = records(output?.output);
              const spawn = (collect: boolean) =>
                writeToolCall(response, "sessions_spawn", {
                  task: "CHILD_" + scenario.marker,
                  agentId: "main",
                  runtime: "subagent",
                  context: "isolated",
                  cleanup: "keep",
                  ...(collect ? { collect: true } : { completionTarget: "parent" }),
                });
              const finishFirst = () => {
                scenario.phase = "continuation";
                return scenario.empty
                  ? ""
                  : "First item checked; final acceptance remains unfinished.";
              };
              const refuse = () => {
                refuseNext = true;
                scenario.phase = "refused";
                spawn(true);
              };
              switch (scenario.phase) {
                case "create":
                  scenario.phase = "created";
                  writeToolCall(response, "create_goal", {
                    objective: "PARENT_" + scenario.marker + " Finish both checks.",
                  });
                  break;
                case "created":
                  expect(toolOutput).toContainEqual(expect.objectContaining({ status: "created" }));
                  if (scenario.collector || scenario.announce) {
                    scenario.phase = "spawned";
                    spawn(scenario.collector);
                  } else {
                    refuse();
                  }
                  break;
                case "spawned": {
                  const receipt = toolOutput.find(
                    (r) => typeof r.runId === "string" && typeof r.childSessionKey === "string",
                  );
                  assert(
                    receipt && typeof receipt.runId === "string",
                    "real spawn receipt required",
                  );
                  scenario.childRunId = receipt.runId;
                  if (scenario.announce) {
                    scenario.phase = "returned";
                    writeToolCall(response, "sessions_yield", {});
                  } else {
                    scenario.phase = "collected";
                    writeToolCall(response, "agents_wait", {
                      ids: [scenario.childRunId],
                      awaitResults: true,
                    });
                  }
                  break;
                }
                case "collected":
                  expect(toolOutput).toContainEqual(
                    expect.objectContaining({
                      runId: scenario.childRunId,
                      status: "done",
                      result: "CHILD_DONE_" + scenario.marker,
                    }),
                  );
                  expect(
                    getSubagentRunByRunId(scenario.childRunId)?.execution.endedAt,
                  ).toBeDefined();
                  scenario.collected = true;
                  if (scenario.refuse) {
                    refuse();
                  } else {
                    return finishFirst();
                  }
                  break;
                case "refused":
                  expect(toolOutput).toContainEqual(
                    expect.objectContaining({
                      status: "error",
                      error:
                        "sessions_spawn could not verify the selected model: Plugin inventory has retired; begin a new plugin operation.",
                    }),
                  );
                  scenario.refused++;
                  return finishFirst();
                case "returned":
                  expect(body).toContain("CHILD_DONE_" + scenario.marker);
                  return finishFirst();
                case "continuation":
                  if (scenario.empty && !body.includes("Advance the active goal")) {
                    return "";
                  }
                  expect(body).toContain("Advance the active goal");
                  scenario.continuationCalls++;
                  scenario.phase = "complete";
                  writeToolCall(response, "update_goal", { status: "complete" });
                  break;
                case "complete":
                  return "GOAL_DONE_" + scenario.marker;
                default:
                  throw new Error("Unexpected phase");
              }
              return undefined;
            } catch (error) {
              scenario.failed.reject(error);
              return "Fixture assertion failed.";
            }
          },
        });
        await runQaGatewayFixture(
          async () => {
            await fixture.start();
            for (const scenario of scenarios) {
              const wait = <T>(promise: Promise<T>) =>
                withinTest(Promise.race([promise, scenario.failed.promise]), signal);
              scenario.sessionKey = (
                await fixture.client.request<{ key: string }>("sessions.create", {
                  agentId: "main",
                  label: scenario.name,
                })
              ).key;
              const accepted = await fixture.client.request<{ runId: string }>("chat.send", {
                sessionKey: scenario.sessionKey,
                message: "PARENT_" + scenario.marker + " Create a Goal and start the first check.",
                idempotencyKey: randomUUID(),
              });
              if (scenario.announce) {
                await wait(scenario.childStarted.promise);
                expect(scenario.continuationCalls).toBe(0);
                expect(
                  (
                    await listUnsettledRequesterChildren({
                      requesterSessionKey: scenario.sessionKey,
                      requesterAgentId: "main",
                    })
                  ).length,
                ).toBe(1);
                scenario.releaseChild.resolve();
              }
              expect(
                await wait(
                  fixture.client.request("agent.wait", {
                    runId: accepted.runId,
                    timeoutMs: 30_000,
                  }),
                ),
              ).toMatchObject({ status: "ok" });
              const drained = await wait(waitForGatewayActiveWork(30_000));
              expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
              const goal = loadSessionEntry({
                agentId: "main",
                sessionKey: scenario.sessionKey,
              })?.goal;
              console.log(
                "GOAL_DISPOSITION",
                JSON.stringify({
                  name: scenario.name,
                  status: goal?.status,
                  collected: scenario.collected,
                  refused: scenario.refused,
                  childCalls: scenario.childCalls,
                  decisions: scenario.decisions,
                }),
              );
              expect(scenario.collected).toBe(scenario.collector);
              expect(scenario.refused).toBe(Number(scenario.refuse));
              expect(scenario.childCalls).toBe(Number(scenario.collector || scenario.announce));
              expect(
                await listUnsettledRequesterChildren({
                  requesterSessionKey: scenario.sessionKey,
                  requesterAgentId: "main",
                }),
              ).toEqual([]);
              if (!scenario.empty) {
                expect.soft(goal?.status, scenario.name).toBe("complete");
                expect.soft(scenario.continuationCalls, scenario.name).toBe(1);
              } else {
                expect(scenario.decisions.some((d) => d.errors > 0)).toBe(true);
                expect(scenario.continuationCalls).toBe(0);
                expect(goal).toMatchObject({
                  status: "paused",
                  lastStatusNote: expect.stringContaining("Resume"),
                });
              }
              expect(fixture.errors).toEqual([]);
            }
          },
          async () => {
            for (const scenario of scenarios) {
              scenario.releaseChild.resolve();
            }
            await fixture.close();
          },
        );
      },
    );
  },
);
