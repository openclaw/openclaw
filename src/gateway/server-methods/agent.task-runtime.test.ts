import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import { findTaskByRunId } from "../../tasks/task-registry.js";
import { setDetachedTaskLifecycleRuntime } from "../../tasks/task-runtime.test-helpers.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  describe0AfterEach0,
  expectRecordFields,
  expectStringFieldContains,
  invokeAgent,
  makeContext,
  mockCallArg,
  primeMainAgentRun,
  resetAgentTaskRegistryForTests,
  restoreAgentTaskRegistryRuntimeAfterTests,
  useTestStateDir,
  waitForAssertion,
} from "./agent.test-harness.js";

resetAgentTaskRegistryForTests();
afterAll(restoreAgentTaskRegistryRuntimeAfterTests);

describe("gateway agent detached task lifecycle", () => {
  afterEach(describe0AfterEach0);

  it("dispatches async gateway agent task creation through the detached task runtime seam", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-seam-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const createRunningTaskRunSpy = vi.fn(
        (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
          defaultRuntime.createRunningTaskRun(...args),
      );
      const finalizeTaskRunByRunIdSpy = vi.fn(
        (...args: Parameters<NonNullable<typeof defaultRuntime.finalizeTaskRunByRunId>>) =>
          defaultRuntime.finalizeTaskRunByRunId!(...args),
      );

      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        createRunningTaskRun: createRunningTaskRunSpy,
        finalizeTaskRunByRunId: finalizeTaskRunByRunIdSpy,
      });

      await invokeAgent(
        {
          message: "background cli seam task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-agent-seam",
        },
        { reqId: "task-registry-agent-seam" },
      );

      expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
        runtime: "cli",
        runId: "task-registry-agent-seam",
        childSessionKey: "agent:main:main",
        sourceId: "task-registry-agent-seam",
      });
      expectStringFieldContains(
        mockCallArg(createRunningTaskRunSpy) as Record<string, unknown>,
        "task",
        "background cli seam task",
      );
      await waitForAssertion(() => {
        expect(finalizeTaskRunByRunIdSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(finalizeTaskRunByRunIdSpy), {
          runtime: "cli",
          runId: "task-registry-agent-seam",
          status: "succeeded",
          terminalSummary: "completed",
        });
        expectRecordFields(findTaskByRunId("task-registry-agent-seam"), {
          runtime: "cli",
          childSessionKey: "agent:main:main",
          status: "succeeded",
          terminalSummary: "completed",
        });
      });
    });
  });

  it("logs a swallowed finalize error without blocking the background run", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-finalize-throw-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      primeMainAgentRun();

      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      const finalizeError = new Error("finalize boom");
      // The background run completes off-turn; signal finalize instead of
      // polling for it so contended runners cannot outlast a fixed poll budget.
      const { promise: finalizeCalled, resolve: signalFinalizeCalled } = createDeferred();
      const finalizeTaskRunByRunIdSpy = vi.fn(() => {
        signalFinalizeCalled();
        throw finalizeError;
      });
      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        finalizeTaskRunByRunId: finalizeTaskRunByRunIdSpy,
      });

      const context = makeContext();
      const respond = vi.fn();

      await invokeAgent(
        {
          message: "finalize throw seam task",
          sessionKey: "agent:main:main",
          idempotencyKey: "task-registry-finalize-throw",
        },
        { context, respond, reqId: "task-registry-finalize-throw" },
      );

      // Event-driven wait bounded by the test timeout; the follow-up
      // observations land in the same completion path right after finalize.
      await finalizeCalled;
      expect(finalizeTaskRunByRunIdSpy).toHaveBeenCalledTimes(1);
      await waitForAssertion(() => {
        // Finalize threw, but the run must still complete (second res frame with ok status).
        const completed = respond.mock.calls.some(([ok, payload]) => {
          return ok === true && (payload as { status?: string } | undefined)?.status === "ok";
        });
        expect(completed).toBe(true);

        // The swallowed finalize error stays observable via a warn log.
        const warnMock = context.logGateway.warn as ReturnType<typeof vi.fn>;
        const loggedFinalizeError = warnMock.mock.calls.some(([message]) => {
          return (
            typeof message === "string" &&
            message.includes("failed to finalize tracked agent task") &&
            message.includes("finalize boom")
          );
        });
        expect(loggedFinalizeError).toBe(true);
      });
    });
  });
});
