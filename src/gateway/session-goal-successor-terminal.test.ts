import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { persistGoalSuccessorCustody } from "../auto-reply/reply/goal-successor-custody.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import type {
  SessionEventOptions,
  SessionEventReceipt,
} from "../auto-reply/reply/session-event-contract.js";
import * as events from "../auto-reply/reply/session-event-handoff.js";
import {
  configureEventState,
  openEventToolHost,
  startEmbeddedTurn,
} from "../auto-reply/reply/session-event.test-support.js";
import { createSessionGoal } from "../config/sessions/goals.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import {
  resolveActiveReplyOperationForSessionId,
  waitForSessionRunIdle,
  type ReplyOperation,
} from "../sessions/session-controller.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { pairedOperator, recoveryFixture } from "./operator-run-recovery.test-support.js";
import { resumeMarkedSessions } from "./session-restart-resume.js";

// mock-isolation: Only inference is replaced. Recovery, queue, fresh admission,
// managed tool construction/execution, Goal publication and settlement are real.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
  runtime.prewarmConfigDrivenReplyRuntime(),
);

it.for(["complete", "blocked", "next-turn"] as const)(
  "preserves recovered Goal custody through real tool completion and successor admission: %s",
  async (scenario, { signal }) => {
    await withOpenClawTestState(
      { label: "goal-recovery-terminal", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config = await configureEventState(state, {
          messages: { queue: { mode: "followup" } },
        });
        const profile = ensureProfileForEmail("goal-terminal@example.test");
        const fixture = await recoveryFixture(state.stateDir, profile.id, {
          device: pairedOperator(),
          config,
        });
        fixture.context.resolveGatewayContext = () => fixture.context;
        const target = fixture.target;
        const read = () => loadExactSessionEntry(target)!.entry;
        await createSessionGoal({ ...target, objective: "Finish the checked deliverable" });
        const source = await fixture.restore();
        if (!source) {
          throw new Error("Missing fixture source authority");
        }
        const base: FollowupRun = {
          prompt: "Continue",
          enqueuedAt: 1,
          operatorAuthority: source.authority,
          toolsAllow: ["read", "update_goal"],
          run: {
            agentId: target.agentId,
            agentDir: state.stateDir,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            sessionFile: target.sessionKey,
            workspaceDir: state.workspaceDir,
            config,
            provider: "mock-openai",
            model: "gpt-5.6-luna",
            timeoutMs: 1000,
            blockReplyBreak: "text_end",
            senderIsOwner: false,
            sessionEventOrigin: { deliver: false },
          },
        };
        const controller = new AbortController();
        const runSignal = AbortSignal.any([signal, controller.signal]);
        let receipt: SessionEventReceipt | undefined;
        let options: SessionEventOptions | undefined;
        const secondFinished = createDeferredCore();
        const enqueue = events.enqueueSessionEventForHost;
        const observe = vi
          .spyOn(events, "enqueueSessionEventForHost")
          .mockImplementation((text, input) => {
            options = input;
            receipt = enqueue(text, input);
            return receipt;
          });
        let calls = 0;
        let secondOperation: ReplyOperation | undefined;
        model.mockReset().mockImplementation(async (params) => {
          calls += 1;
          if (scenario === "next-turn" && calls === 1) {
            await startEmbeddedTurn(params, "first recovered turn");
            return {
              payloads: [{ text: "Verified the first part; work remains." }],
              meta: { durationMs: 1, stopReason: "stop" },
            };
          }
          if (scenario === "next-turn") {
            expect(calls).toBe(2);
            if (!receipt) {
              throw new Error("Missing first-turn settlement");
            }
            expect(await withinTest(receipt.settled, runSignal)).toMatchObject({
              status: "completed",
            });
            // Prove that the old occurrence really expired before the new admission.
            expect(() => options!.assertCurrent!()).toThrow();
            secondOperation = resolveActiveReplyOperationForSessionId(params.sessionId);
            expect(secondOperation).toBeDefined();
          }
          const host = await openEventToolHost(params, "recovered Goal tool", {
            includeOpenClawTools: true,
          });
          try {
            expect(params.abortSignal?.aborted).not.toBe(true);
            const tool = host.tools.find((candidate) => candidate.name === "update_goal");
            if (!tool) {
              throw new Error("Real admitted Goal tool missing");
            }
            const status = scenario === "blocked" ? "blocked" : "complete";
            const result = await tool.execute("finish-goal", {
              status,
              note: "Checked native-independent result",
            });
            expect(result.details).toMatchObject({ status: "updated", goal: { status } });
            expect(read().goal?.status).toBe(status);
            expect(params.abortSignal?.aborted).not.toBe(true);
            if (scenario !== "next-turn") {
              options!.assertCurrent!();
            }
            if (scenario === "next-turn") {
              secondFinished.resolve();
            }
            return {
              payloads: [{ text: "Checked final response after update_goal." }],
              meta: { durationMs: 1, stopReason: "stop" },
            };
          } finally {
            host.close();
          }
        });
        const log = { warn: vi.fn() };
        let startup: Promise<void> | undefined;
        try {
          expect(
            await persistGoalSuccessorCustody({
              base,
              entry: read(),
              sessionKey: target.sessionKey,
              storePath: target.storePath,
              sourceRunId: "pre-restart-terminal",
              phase: "pending",
              assertCurrent: source.authority.assertCurrent,
            }),
          ).toBe(true);
          startup = runWithGatewayIndependentRootWorkAdmission(
            () =>
              withPluginRuntimeGatewayContextResolver(
                () => fixture.context,
                () => resumeMarkedSessions({ context: fixture.context, signal: runSignal, log }),
              ),
            "startup:session-resume",
            runSignal,
          );
          await withinTest(startup, signal);
          expect(receipt, JSON.stringify(log.warn.mock.calls)).toBeDefined();
          if (!receipt) {
            throw new Error("Startup did not admit recovery");
          }
          expect(await receipt.accepted).toEqual({ ok: true });
          const outcome = await withinTest(receipt.settled, signal);
          expect(outcome, outcome.error).toMatchObject({
            status: "completed",
            executionStarted: true,
          });
          if (scenario === "next-turn") {
            await withinTest(secondFinished.promise, signal);
            expect(await waitForSessionRunIdle(target.sessionKey, 10_000, { signal })).toBe(true);
            expect(secondOperation?.result).toMatchObject({ kind: "completed" });
          }
          expect(calls).toBe(scenario === "next-turn" ? 2 : 1);
          expect(read().goal?.status).toBe(scenario === "blocked" ? "blocked" : "complete");
        } finally {
          controller.abort();
          await Promise.allSettled([startup, receipt?.settled]);
          observe.mockRestore();
          source.release();
        }
      },
    );
  },
);
