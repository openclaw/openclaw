// Covers managed task-flow audit summaries and stale-flow classification.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskFlowRegistryStore } from "../test-utils/task-registry-store.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import {
  createRunningTaskRunCore as createRunningTaskRunOrNull,
  finalizeTaskRunByRunIdCore as finalizeTaskRunByRunId,
} from "./task-executor.js";
import { listTaskFlowAuditFindings } from "./task-flow-registry.audit.js";
import type { TaskFlowAuditCode, TaskFlowAuditFinding } from "./task-flow-registry.audit.types.js";
import { requestFlowCancel, setFlowWaiting } from "./task-flow-registry.js";
import { createManagedTaskFlow } from "./task-flow-registry.test-support.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { tasks } from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";
import { RETAINED_YIELD_GUIDANCE } from "./task-retained-yield-guidance.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
} from "./task-runtime.test-helpers.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

function createRunningTaskRun(
  params: Parameters<typeof createRunningTaskRunOrNull>[0],
): TaskRecord {
  // Audit fixtures intentionally omit the executor helper's synthetic backing metadata.
  return expectDefined(createRunningTaskRunOrNull(params), "running audit task");
}

function requireFinding(
  findings: TaskFlowAuditFinding[],
  code: TaskFlowAuditCode,
  flowId?: string,
): TaskFlowAuditFinding {
  const finding = findings.find(
    (candidate) =>
      candidate.code === code && (flowId === undefined || candidate.flow?.flowId === flowId),
  );
  if (!finding) {
    throw new Error(`Expected ${code} finding${flowId ? ` for ${flowId}` : ""}`);
  }
  return finding;
}

async function withTaskFlowAuditStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-task-flow-audit-",
    },
    async (state) => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run(state.stateDir);
      } finally {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("task-flow-registry audit", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("surfaces restore failures as task-flow audit findings", () => {
    const loadSnapshot = vi.fn(() => {
      throw new Error("boom");
    });
    configureTaskFlowRegistryRuntime({
      store: {
        ...createInMemoryTaskFlowRegistryStore(),
        loadSnapshot,
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const findings = listTaskFlowAuditFindings();
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("error");
      expect(findings[0]?.code).toBe("restore_failed");
      expect(findings[0]?.detail).toContain("boom");
    }
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("clears restore-failed findings after a clean reset and restore", () => {
    configureTaskFlowRegistryRuntime({
      store: {
        ...createInMemoryTaskFlowRegistryStore(),
        loadSnapshot: () => {
          throw new Error("boom");
        },
      },
    });

    const findings = listTaskFlowAuditFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("restore_failed");

    resetTaskFlowRegistryForTests({ persist: false });
    configureTaskFlowRegistryRuntime({
      store: {
        ...createInMemoryTaskFlowRegistryStore(),
        loadSnapshot: () => ({
          flows: new Map(),
        }),
      },
    });

    expect(listTaskFlowAuditFindings()).toStrictEqual([]);
  });

  it("detects stuck managed flows and missing blocked tasks", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const running = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Inspect queue",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });

      const blocked = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Wait on child",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });
      setFlowWaiting({
        flowId: blocked.flowId,
        expectedRevision: blocked.revision,
        blockedTaskId: "task-missing",
        blockedSummary: "Need follow-up",
        updatedAt: 1,
      });

      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(requireFinding(findings, "missing_linked_tasks", running.flowId).flow?.flowId).toBe(
        running.flowId,
      );
      expect(requireFinding(findings, "blocked_task_missing", blocked.flowId).flow?.flowId).toBe(
        blocked.flowId,
      );
    });
  });

  it("keeps linked task checks scoped to each managed flow", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Inspect queue",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });

      const task = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "task-flow-audit-child",
        task: "Inspect PR 1",
        startedAt: 1,
        lastEventAt: 1,
      });

      const otherFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Wait on a task linked to another flow",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });
      setFlowWaiting({
        flowId: otherFlow.flowId,
        expectedRevision: otherFlow.revision,
        blockedTaskId: task.taskId,
        updatedAt: 1,
      });
      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(
        findings.some(
          (finding) =>
            finding.code === "missing_linked_tasks" && finding.flow?.flowId === flow.flowId,
        ),
      ).toBe(false);
      expect(requireFinding(findings, "blocked_task_missing", otherFlow.flowId).detail).toContain(
        task.taskId,
      );
    });
  });

  it("does not flag missing linked tasks before the flow is stale", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const now = Date.now();
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Fresh managed flow",
        status: "running",
        createdAt: now - 5 * 60_000,
        updatedAt: now - 5 * 60_000,
      });

      expect(
        listTaskFlowAuditFindings({ now }).find(
          (finding) => finding.code === "missing_linked_tasks",
        ),
      ).toBeUndefined();

      const staleFindings = listTaskFlowAuditFindings({ now: now + 26 * 60_000 });
      expect(requireFinding(staleFindings, "missing_linked_tasks", flow.flowId).flow?.flowId).toBe(
        flow.flowId,
      );
    });
  });

  it("names a mirrored flow only when every linked running task is a retained yield", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const yieldedFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Retained yield",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });
      const yielded = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: yieldedFlow.flowId,
        childSessionKey: "agent:main:subagent:yield-flow",
        runId: "task-flow-yield-owner",
        task: "Wait after yield",
        startedAt: 1,
        lastEventAt: 1,
      });
      const yieldedStored = expectDefined(tasks.get(yielded.taskId), "yielded task");
      yieldedStored.lastToolName = "sessions_yield";

      const mixedFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Mixed work",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });
      const mixedYield = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: mixedFlow.flowId,
        childSessionKey: "agent:main:subagent:mixed-yield",
        runId: "task-flow-mixed-yield",
        task: "Yielded sibling",
        startedAt: 1,
        lastEventAt: 1,
      });
      const mixedLive = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: mixedFlow.flowId,
        childSessionKey: "agent:main:subagent:mixed-live",
        runId: "task-flow-mixed-live",
        task: "Live sibling",
        startedAt: 1,
        lastEventAt: 1,
      });
      const mixedYieldStored = expectDefined(tasks.get(mixedYield.taskId), "mixed yielded task");
      const mixedLiveStored = expectDefined(tasks.get(mixedLive.taskId), "mixed live task");
      mixedYieldStored.lastToolName = "sessions_yield";
      mixedLiveStored.lastToolName = "read";

      const findings = listTaskFlowAuditFindings({ now: 31 * 60_000 });
      expect(requireFinding(findings, "stale_running", yieldedFlow.flowId).detail).toBe(
        RETAINED_YIELD_GUIDANCE,
      );
      expect(requireFinding(findings, "stale_running", mixedFlow.flowId).detail).toBe(
        "running TaskFlow has not advanced recently",
      );
    });
  });

  it("does not flag retained terminal blocked flows after their task is pruned", () => {
    const now = 60 * 60_000;
    const flow: TaskFlowRecord = {
      flowId: "flow-terminal-blocked",
      syncMode: "task_mirrored",
      ownerKey: "agent:main:main",
      revision: 0,
      status: "blocked",
      notifyPolicy: "done_only",
      goal: "Historical blocked task",
      blockedTaskId: "task-pruned",
      createdAt: 1,
      updatedAt: 100,
      endedAt: 100,
    };

    expect(listTaskFlowAuditFindings({ flows: [flow], now })).toStrictEqual([]);
  });

  it("reports cancel-stuck before maintenance finalizes the flow", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Cancel work",
        status: "running",
        cancelRequestedAt: 100,
        createdAt: 1,
        updatedAt: 100,
      });

      const findings = listTaskFlowAuditFindings({ now: 6 * 60_000 });
      expect(requireFinding(findings, "cancel_stuck", flow.flowId).flow?.flowId).toBe(flow.flowId);
    });
  });

  it("counts provisional subagent cancellation as active during audit", async () => {
    await withTaskFlowAuditStateDir(async () => {
      const now = Date.now();
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-audit",
        goal: "Cancel subagent work",
        status: "running",
        createdAt: now - 6 * 60_000,
        updatedAt: now - 6 * 60_000,
      });
      const runId = "run-provisional-cancel-audit";
      const task = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:subagent:provisional-cancel",
        runId,
        task: "Wait for kill reconciliation",
        startedAt: now - 6 * 60_000,
        lastEventAt: now - 6 * 60_000,
      });
      expect(task.runId).toBe(runId);
      requestFlowCancel({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        cancelRequestedAt: now - 6 * 60_000,
        updatedAt: now - 6 * 60_000,
      });
      finalizeTaskRunByRunId({
        runId,
        runtime: "subagent",
        status: "cancelled",
        endedAt: now - 6 * 60_000,
        error: SUBAGENT_KILL_TASK_ERROR,
      });

      expect(
        listTaskFlowAuditFindings({ now }).find(
          (finding) => finding.code === "cancel_stuck" && finding.flow?.flowId === flow.flowId,
        ),
      ).toBeUndefined();
    });
  });
});
