import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { normalizeAcceptedSessionSpawnResult } from "../agents/accepted-session-spawn.js";
import { agentCommandFromGatewayIngress } from "../agents/agent-command.js";
import { prepareAgentRunTerminalReply } from "../agents/agent-run-terminal-reply.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { createRequesterYieldCallback } from "../agents/openclaw-tools.requester-yield.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  getSubagentRunByRunId,
} from "../agents/subagents/registry/subagent-registry.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../agents/tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "../agents/tools/sessions-yield-tool.js";
import * as followupDrain from "../auto-reply/reply/queue/drain.js";
import { getFollowupQueueDepth } from "../auto-reply/reply/queue/enqueue.js";
import { getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../config/sessions/session-entry-read-runtime.js";
import { publishSystemEventStoreConfig } from "../config/sessions/session-store-path.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import * as sessionLifecycle from "../sessions/session-lifecycle-admission.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { agentCommandMock, prepareGatewayReplyRuntimeForTest, testState } from "./test-helpers.js";

const { getSessionWorkAdmissionRelease } = sessionLifecycle;

type Scope = { agentId: string; sessionKey: string; sessionId: string; storePath: string };

/** The suite boots one Gateway; only provider execution is replaced, never child custody. */
export function registerGoalChildSettlementCases(fixture: {
  scope: () => Scope;
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>;
  context: () => GatewayRequestContext;
  client: GatewayClient;
  goalStart: (message: string) => Record<string, unknown>;
  userMessages: () => readonly unknown[];
}) {
  it.for([
    {
      label: "continues a chat Goal through consecutive hidden nudges",
      pause: false,
      stopBeforeDrain: false,
      stopBeforeEnqueue: false,
    },
    {
      label: "does not resume a chat Goal paused while its child runs",
      pause: true,
      stopBeforeDrain: false,
    },
    {
      label: "honors Stop between committed settlement and Goal drain",
      pause: false,
      stopBeforeDrain: true,
      stopBeforeEnqueue: false,
    },
    {
      label: "honors Stop after commit before Goal enqueue",
      pause: false,
      stopBeforeDrain: false,
      stopBeforeEnqueue: true,
    },
  ])(
    "$label after real child settlement",
    async ({ pause, stopBeforeDrain, stopBeforeEnqueue }, { signal }) => {
      const scope = fixture.scope();
      const originalConfig = getRuntimeConfig();
      const originalAgentConfig = testState.agentConfig;
      testState.agentConfig = {
        model: { primary: "goal-fixture/checklist" },
        thinkingDefault: "off",
      };
      const config = getRuntimeConfig();
      await writeConfigFile({
        ...config,
        models: {
          providers: {
            "goal-fixture": {
              api: "openai-responses",
              apiKey: "synthetic-goal-fixture-key",
              baseUrl: "https://example.invalid",
              models: [
                {
                  id: "checklist",
                  name: "Goal fixture",
                  input: ["text"],
                  reasoning: false,
                  contextWindow: 16_000,
                  maxTokens: 2_048,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      });
      await prepareGatewayReplyRuntimeForTest({ force: true });
      publishSystemEventStoreConfig(getRuntimeConfig());
      await initSubagentRegistry();
      const resolveGatewayContext = fixture.context().resolveGatewayContext;
      assert(resolveGatewayContext, "the suite Gateway owns registry dispatch");
      await activateSubagentRegistry(resolveGatewayContext);
      const goalQueued = createDeferred();
      const scheduleDrain = followupDrain.scheduleFollowupDrain;
      let releaseDrain: (() => void) | undefined;
      const drainControl = stopBeforeDrain
        ? vi.spyOn(followupDrain, "scheduleFollowupDrain").mockImplementation((key, run) => {
            if (getFollowupQueueDepth(key) > 0) {
              releaseDrain = () => scheduleDrain(key, run);
              goalQueued.resolve();
            } else {
              scheduleDrain(key, run);
            }
          })
        : undefined;
      const childRelease = createDeferred();
      const yieldReleased = createDeferred();
      const settlementFinished = createDeferred();
      const failures = createDeferred<never>();
      void failures.promise.catch(() => {});
      let childRunId: string | undefined;
      let requesterTurns = 0;
      const prompts: string[] = [];
      const goalReadStarted = createDeferred();
      const releaseGoalRead = createDeferred();
      let readHeld = false;
      const goalHasQueueCustody = () => {
        const queue = getExistingFollowupQueue(scope.sessionKey);
        return queue && [...queue.items, ...queue.inFlight].some((run) => run.goalContinuation);
      };
      const readEntry = sessionEntryReads.readSessionEntryReadOnlyInWorker;
      const readControl = stopBeforeEnqueue
        ? vi
            .spyOn(sessionEntryReads, "readSessionEntryReadOnlyInWorker")
            .mockImplementation(async (...args) => {
              const result = await readEntry(...args);
              const child = childRunId && getSubagentRunByRunId(childRunId);
              if (
                !readHeld &&
                args[0].sessionKey === scope.sessionKey &&
                args[0].agentId === undefined &&
                requesterTurns === 2 &&
                child &&
                !child.requesterSettleWake &&
                !goalHasQueueCustody()
              ) {
                readHeld = true;
                goalReadStarted.resolve();
                await releaseGoalRead.promise;
              }
              return result;
            })
        : undefined;
      const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
        const child = childRunId && getSubagentRunByRunId(childRunId);
        if (child && child.requesterSettleWake?.requesterYieldBatch && !child.requesterTurnRunId) {
          yieldReleased.resolve();
        }
        if (child && child.delivery?.status === "suspended") {
          failures.reject(new Error("Child delivery suspended: " + child.delivery.lastError));
        }
        if (child && child.cleanupCompletedAt !== undefined && !child.requesterSettleWake) {
          settlementFinished.resolve();
        }
      });
      // Both the child and its requester completion use the normal command entrypoint.
      agentCommandMock.mockImplementation((...args) =>
        agentCommandFromGatewayIngress(
          ...(args as Parameters<typeof agentCommandFromGatewayIngress>),
        ),
      );
      fixture.runEmbeddedAgent.mockImplementation(async (params) => {
        try {
          assert(params.preparedRunAdmission, "the real reply/command owner prepared admission");
          const admitted = await params.preparedRunAdmission.admit("embedded");
          const result = (text: string) => ({
            payloads: [{ text }],
            meta: {
              durationMs: 0,
              stopReason: "end_turn",
              terminalReply: prepareAgentRunTerminalReply({ rawText: text }).terminalReply,
              agentMeta: {
                agentHarnessId: "openclaw",
                sessionId: params.sessionId,
                provider: params.provider ?? "goal-fixture",
                model: params.model ?? "checklist",
                usage: { input: 1, output: 1 },
              },
            },
          });
          if (params.sessionKey !== scope.sessionKey) {
            await childRelease.promise;
            return result("Child verified the first checklist item.");
          }
          requesterTurns++;
          prompts.push(params.prompt);
          if (requesterTurns > 4) {
            throw new Error("Goal continued after it was marked complete");
          }
          if (requesterTurns === 1) {
            const caller = createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: scope.agentId,
              sessionKey: scope.sessionKey,
            });
            assert(caller);
            return await withGatewayToolCallerIdentity(caller, async () => {
              const spawned = await createSessionsSpawnTool({
                agentSessionKey: scope.sessionKey,
                expectedParentSessionId: params.sessionId,
                requesterTurnRunId: params.runId,
                requesterAgentIdOverride: scope.agentId,
                requesterRunId: params.runId,
                workspaceDir: params.workspaceDir,
                config: getRuntimeConfig(),
              }).execute("goal-spawn-child", {
                task: "Verify the first checklist item and return the finding.",
                runtime: "subagent",
                completionTarget: "parent",
                cleanup: "keep",
              });
              const accepted = normalizeAcceptedSessionSpawnResult(spawned);
              assert(accepted, JSON.stringify(spawned));
              childRunId = accepted.runId;
              let yielded = false;
              const yieldResult = await createSessionsYieldTool({
                sessionId: params.sessionId,
                claimYield: createRequesterYieldCallback({
                  requesterSessionKey: scope.sessionKey,
                  requesterAgentId: scope.agentId,
                  requesterTurnRunId: params.runId,
                }),
                onYield: () => {
                  // The provider callback cannot end its turn until the registry commit exists.
                  expect(getSubagentRunByRunId(accepted.runId)?.requesterTurnYielded).toBe(true);
                  yielded = true;
                },
              }).execute("goal-await-child", {});
              expect(yieldResult).toMatchObject({ details: { status: "yielded" } });
              expect(yielded).toBe(true);
              return {
                ...result(""),
                payloads: [],
                acceptedSessionSpawns: [accepted],
                meta: { ...result("").meta, yielded },
              };
            });
          }
          if (requesterTurns === 4) {
            await patchSessionEntryCore(scope, (entry) => ({
              goal: entry.goal ? { ...entry.goal, status: "complete" } : undefined,
            }));
          }
          return result(
            requesterTurns === 4
              ? "Verified the entire objective."
              : "More checklist work remains.",
          );
        } catch (error) {
          failures.reject(error);
          throw error;
        }
      });
      try {
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "goal-with-child",
            method: "chat.send",
            params: fixture.goalStart("Finish and verify a checklist with a delegated first item"),
          },
          context: fixture.context(),
          client: fixture.client,
          isWebchatConnect: () => true,
          respond,
        });
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        await withinTest(Promise.race([yieldReleased.promise, failures.promise]), signal);
        expect(requesterTurns, "no Goal nudge may race the pending child").toBe(1);
        expect(loadSessionEntry(scope)?.goal?.status).toBe("active");
        if (pause) {
          const paused = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "pause-delegated-goal",
              method: "sessions.goal.update",
              params: {
                sessionKey: scope.sessionKey,
                sessionId: scope.sessionId,
                goalId: loadSessionEntry(scope)?.goal?.id,
                action: "pause",
                operationId: randomUUID(),
                issuedAtMs: Date.now(),
              },
            },
            context: fixture.context(),
            client: fixture.client,
            isWebchatConnect: () => true,
            respond: paused,
          });
          expect(paused.mock.calls[0]?.[0], JSON.stringify(paused.mock.calls)).toBe(true);
        }
        childRelease.resolve();
        if (stopBeforeEnqueue) {
          await withinTest(Promise.race([goalReadStarted.promise, failures.promise]), signal);
          expect(
            goalHasQueueCustody(),
            "the durable batch is settled but Goal enqueue still awaits its read",
          ).toBeFalsy();
        } else {
          await withinTest(Promise.race([settlementFinished.promise, failures.promise]), signal);
        }
        if (stopBeforeDrain) {
          await withinTest(Promise.race([goalQueued.promise, failures.promise]), signal);
        }
        if (stopBeforeDrain || stopBeforeEnqueue) {
          const stopped = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "stop-settled-goal",
              method: "sessions.abort",
              params: { key: scope.sessionKey, clearQueued: true },
            },
            context: fixture.context(),
            client: fixture.client,
            isWebchatConnect: () => true,
            respond: stopped,
          });
          expect(stopped.mock.calls[0]?.[0]).toBe(true);
          releaseGoalRead.resolve();
          drainControl?.mockRestore();
          releaseDrain?.();
        }
        const drained = await waitForGatewayActiveWork(30_000);
        expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
        expect(requesterTurns, "settlement resumes only a still-active Goal").toBe(
          pause || stopBeforeDrain || stopBeforeEnqueue ? 2 : 4,
        );
        expect(prompts[1]).toContain("Child verified the first checklist item.");
        if (!pause && !stopBeforeDrain && !stopBeforeEnqueue) {
          expect(prompts[2]).toContain("Advance");
          expect(prompts[3]).toContain("Advance");
        }
        expect(fixture.userMessages()).toHaveLength(1);
        expect(loadSessionEntry(scope)?.goal?.status).toBe(
          pause ? "paused" : stopBeforeDrain || stopBeforeEnqueue ? "active" : "complete",
        );
      } finally {
        readControl?.mockRestore();
        releaseGoalRead.resolve();
        drainControl?.mockRestore();
        releaseDrain?.();
        childRelease.resolve();
        await patchSessionEntryCore(scope, (entry) => ({
          goal: entry.goal?.status === "active" ? { ...entry.goal, status: "paused" } : entry.goal,
        }));
        await waitForGatewayActiveWork(30_000);
        unsubscribe();
        await resetSubagentRegistryForTests({ persist: false });
        testState.agentConfig = originalAgentConfig;
        await writeConfigFile(originalConfig);
        publishSystemEventStoreConfig(originalConfig);
      }
    },
  );
}

export async function waitForGoalChatModelRun(params: {
  scope: Scope;
  context: GatewayRequestContext;
  modelStarted: Promise<void>;
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>;
  count: number;
}) {
  const { scope, context, modelStarted, runEmbeddedAgent, count } = params;
  const { storePath, sessionKey, sessionId } = scope;
  await Promise.race([
    modelStarted,
    getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] }),
  ]);
  expect(context.logGateway.error).not.toHaveBeenCalled();
  let failureDiagnostic: string | undefined;
  if (runEmbeddedAgent.mock.calls.length !== count) {
    const entry = loadSessionEntry(scope);
    failureDiagnostic = JSON.stringify({
      warningCount: vi.mocked(context.logGateway.warn).mock.calls.length,
      abortControllers: context.chatAbortControllers.size,
      admissionScopes: [...sessionLifecycle.collectActiveSessionWorkAdmissions()]
        .filter(([, identities]) => identities.has(sessionKey))
        .slice(0, 5)
        .map(([activeScope, identities]) => ({
          file: path.basename(activeScope),
          matchesExpected: activeScope === storePath,
          identityCount: identities.size,
          includesExpectedSessionId: identities.has(sessionId),
        })),
      dedupe: [...context.dedupe]
        .filter(([key]) => key.startsWith("chat:"))
        .slice(0, 5)
        .map(([key, cached]) => ({
          key,
          ok: cached.ok,
          status: isRecord(cached.payload) ? cached.payload.status : undefined,
          error: cached.error && { code: cached.error.code, message: cached.error.message },
        })),
      entry: entry && {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        status: entry.status,
        lastRunId: entry.lastRunId,
        abortedLastRun: entry.abortedLastRun,
      },
    });
  }
  expect(runEmbeddedAgent.mock.calls, failureDiagnostic).toHaveLength(count);
}
