import { afterEach, expect, it, vi } from "vitest";
import {
  createExecutionIdentityRecoveryAdmission,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createRunningTaskRunCore, finalizeTaskRunByRunIdCore } from "../../tasks/task-executor.js";
import { createManagedTaskFlow } from "../../tasks/task-flow-registry.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.command }));

afterEach(() => {
  mocks.command.mockReset();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

it("retains exact task and flow provenance through the registered Gateway start callback", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
    const { runId, sessionKey, context, entry, task: input } = createTrackedDispatch();
    const flow = createManagedTaskFlow({
      ownerKey: sessionKey,
      controllerId: "tests/gateway-execution-binding",
      goal: "Retain Gateway execution provenance",
      status: "running",
    });
    if (!flow) {
      throw new Error("Expected a real managed parent flow");
    }
    const task = createRunningTaskRunCore({ ...input, parentFlowId: flow.flowId });
    if (!task?.parentFlowId) {
      throw new Error("Expected a real task and its initial flow");
    }
    const admission = prepareAgentRunAdmission({
      cfg: { logging: { audit: { executionIdentity: true } } },
      operationalRunInstance: entry.operationalRunInstance!,
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "gateway-client", boundary: "test", state: "present" },
      },
      recovery: createExecutionIdentityRecoveryAdmission({
        retryOnly: true,
        token: createExecutionIdentityAdmissionToken(runId, {
          contextId: "gateway-binding-context",
          executionId: "gateway-binding-execution",
        }),
      }),
    });
    let boundBeforeCompletion = false;
    mocks.command.mockImplementation(async (options) => {
      const admitted = await admission.admit("gateway");
      await options.onPostAdmittedRunContext?.(admitted);
      await options.onExecutionStarted?.();
      const db = openOpenClawStateDatabase().db;
      expect(
        db
          .prepare(
            "SELECT owner_kind, owner_id, context_id, execution_id FROM execution_owner_lifecycle_bindings ORDER BY owner_kind",
          )
          .all(),
      ).toEqual([
        {
          owner_kind: "flow",
          owner_id: task.parentFlowId,
          context_id: "gateway-binding-context",
          execution_id: "gateway-binding-execution",
        },
        {
          owner_kind: "task",
          owner_id: task.taskId,
          context_id: "gateway-binding-context",
          execution_id: "gateway-binding-execution",
        },
      ]);
      boundBeforeCompletion = true;
      return { payloads: [], meta: { durationMs: 0 } };
    });
    try {
      const outcome = await dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: { message: task.task, sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [`agent:${runId}`],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context,
        taskTrackingMode: { kind: "legacy", task, finalizeRun: finalizeTaskRunByRunIdCore },
        assertSettlementCurrent() {},
      });
      expect(outcome.terminalOutcome.status).toBe("ok");
      expect(boundBeforeCompletion).toBe(true);
      expect(mocks.command).toHaveBeenCalledOnce();
      expect(context.logGateway.warn).not.toHaveBeenCalled();
    } finally {
      admission.close();
    }
  });
});
