import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { blockSafeTask, completeSafeTask, upsertSafeTask } from "../tasks/safe-task-index.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import {
  createTaskRecord,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  tasksAuditCommand,
  tasksDecisionsClassifyCommand,
  tasksDecisionsListCommand,
  tasksMaintenanceCommand,
  tasksMetadataBlockCommand,
  tasksMetadataCompleteCommand,
  tasksMetadataExportCommand,
  tasksMetadataShowCommand,
  tasksMetadataStartCommand,
  tasksPhoneProbeCommand,
  tasksSupervisionCommand,
} from "./tasks.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

async function withTaskCommandStateDir(run: () => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-tasks-command-" },
    async () => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run();
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("tasks commands", () => {
  let previousWorkbenchHome: string | undefined;
  let tempWorkbenchHome: string;

  beforeEach(() => {
    vi.useRealTimers();
    previousWorkbenchHome = process.env.OPENCLAW_WORKBENCH_HOME;
    tempWorkbenchHome = mkdtempSync(join(tmpdir(), "openclaw-safe-task-command-"));
    mkdirSync(join(tempWorkbenchHome, "status"));
    process.env.OPENCLAW_WORKBENCH_HOME = tempWorkbenchHome;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousWorkbenchHome === undefined) {
      delete process.env.OPENCLAW_WORKBENCH_HOME;
    } else {
      process.env.OPENCLAW_WORKBENCH_HOME = previousWorkbenchHome;
    }
    rmSync(tempWorkbenchHome, { recursive: true, force: true });
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("keeps audit JSON stable and sorts combined findings before limiting", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 40 * 60_000);
      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-stale-queued",
        status: "running",
        task: "Inspect issue backlog",
      });
      vi.setSystemTime(now);
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Inspect issue backlog",
        status: "waiting",
        createdAt: now - 40 * 60_000,
        updatedAt: now - 40 * 60_000,
      });

      const runtime = createRuntime();
      await tasksAuditCommand({ json: true }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        summary: {
          total: number;
          errors: number;
          warnings: number;
          byCode: Record<string, number>;
          taskFlows: { total: number; byCode: Record<string, number> };
          combined: { total: number; errors: number; warnings: number };
        };
      };

      expect(payload.summary.byCode.lost).toBe(1);
      expect(payload.summary.taskFlows.byCode.stale_waiting).toBe(1);
      expect(payload.summary.taskFlows.byCode.missing_linked_tasks).toBe(1);
      expect(payload.summary.combined.total).toBe(3);

      const runningFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Running flow",
        status: "running",
        createdAt: now - 45 * 60_000,
        updatedAt: now - 45 * 60_000,
      });

      const limitedRuntime = createRuntime();
      await tasksAuditCommand({ json: true, limit: 1 }, limitedRuntime);

      const limitedPayload = JSON.parse(
        String(vi.mocked(limitedRuntime.log).mock.calls[0]?.[0]),
      ) as {
        findings: Array<{ kind: string; code: string; token?: string }>;
      };

      expect(limitedPayload.findings).toHaveLength(1);
      expect(limitedPayload.findings[0]).toMatchObject({
        kind: "task_flow",
        code: "stale_running",
        token: runningFlow.flowId,
      });
    });
  });

  it("keeps tasks maintenance JSON additive for TaskFlow state", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Old terminal flow",
        status: "succeeded",
        createdAt: now - 8 * 24 * 60 * 60_000,
        updatedAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: false }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        mode: string;
        maintenance: { taskFlows: { pruned: number } };
        auditBefore: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
        };
        auditAfter: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
        };
      };

      expect(payload.mode).toBe("preview");
      expect(payload.maintenance.taskFlows.pruned).toBe(1);
      expect(payload.auditBefore.byCode).toEqual(expect.any(Object));
      expect(Array.isArray(payload.auditBefore.byCode)).toBe(false);
      expect(payload.auditBefore.taskFlows.byCode.stale_running).toBe(0);
      expect(payload.auditAfter.byCode).toEqual(expect.any(Object));
      expect(Array.isArray(payload.auditAfter.byCode)).toBe(false);
      expect(payload.auditAfter.taskFlows.byCode.stale_running).toBe(0);
    });
  });

  it("creates, blocks, completes, shows, and exports explicit safe task metadata", async () => {
    const runtime = createRuntime();

    await tasksMetadataStartCommand(
      {
        taskId: "task-safe-1",
        title: "Local safe work",
        workspace: "/tmp/project",
        risk: "medium",
        allowedActions: "read_status,continue_registered_local_task",
        json: true,
      },
      runtime,
    );
    await tasksMetadataBlockCommand(
      {
        taskId: "task-safe-1",
        reason: "Waiting on local file",
        json: true,
      },
      runtime,
    );
    await tasksMetadataCompleteCommand(
      {
        taskId: "task-safe-1",
        summary: "Finished locally",
        json: true,
      },
      runtime,
    );

    const showRuntime = createRuntime();
    await tasksMetadataShowCommand({ lookup: "task-safe-1", json: true }, showRuntime);
    const showPayload = JSON.parse(String(vi.mocked(showRuntime.log).mock.calls[0]?.[0])) as {
      task: {
        task_id: string;
        title: string;
        workspace: string;
        risk: string;
        status: string;
        blocked_reason: string;
        completed_summary: string;
        allowed_actions: string[];
      };
    };

    expect(showPayload.task).toMatchObject({
      task_id: "task-safe-1",
      title: "Local safe work",
      workspace: "/tmp/project",
      risk: "medium",
      status: "succeeded",
      blocked_reason: "Waiting on local file",
      completed_summary: "Finished locally",
      allowed_actions: ["read_status", "continue_registered_local_task"],
    });

    const exportRuntime = createRuntime();
    await tasksMetadataExportCommand({ json: true }, exportRuntime);
    const exportPayload = JSON.parse(String(vi.mocked(exportRuntime.log).mock.calls[0]?.[0])) as {
      source: string;
      tasks: Array<{ task_id: string }>;
      loadErrors: string[];
    };

    expect(exportPayload).toMatchObject({
      source: "node-safe-task-index",
      loadErrors: [],
      tasks: [{ task_id: "task-safe-1" }],
    });
    expect(exportPayload.tasks[0]).not.toHaveProperty("metadata");
    expect(exportPayload.tasks[0]).not.toHaveProperty("notes");
  });

  it("does not allow metadata start to downgrade a task that needs a decision", async () => {
    upsertSafeTask({
      taskId: "task-needs-decision",
      title: "Needs decision",
      workspace: "/tmp/project",
    });
    blockSafeTask({
      taskId: "task-needs-decision",
      reason: "External send",
      needsDecision: true,
    });

    await expect(
      tasksMetadataStartCommand(
        {
          taskId: "task-needs-decision",
          risk: "low",
          allowedActions: "continue_registered_local_task",
          json: true,
        },
        createRuntime(),
      ),
    ).rejects.toThrow("requires a decision before restart");
  });

  it("does not allow metadata completion to bypass a pending decision", () => {
    upsertSafeTask({
      taskId: "task-complete-needs-decision",
      title: "Needs decision",
      workspace: "/tmp/project",
    });
    blockSafeTask({
      taskId: "task-complete-needs-decision",
      reason: "External send",
      needsDecision: true,
    });

    expect(() =>
      completeSafeTask({
        taskId: "task-complete-needs-decision",
        summary: "Not actually approved",
      }),
    ).toThrow("requires a decision before completion");
  });

  it("fails closed instead of overwriting malformed safe task metadata", async () => {
    const path = join(tempWorkbenchHome, "status", "codex-task-index.json");
    writeFileSync(path, "{not json", "utf8");

    await expect(
      tasksMetadataStartCommand(
        {
          taskId: "task-after-corrupt-index",
          title: "Should not overwrite",
          json: true,
        },
        createRuntime(),
      ),
    ).rejects.toThrow("Cannot write codex-task-index.json");
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  it("classifies hard-boundary actions into pending decision packets", async () => {
    const runtime = createRuntime();

    await tasksDecisionsClassifyCommand(
      {
        action: "deploy release",
        title: "Ship package",
        reason: "external release",
        taskId: "task-deploy",
        workspace: "/tmp/project",
        json: true,
      },
      runtime,
    );

    const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
      classification: { decision: string; risk: string; approvalTarget: string; rollback: string };
      pendingDecision: {
        id: string;
        action: string;
        risk: string;
        approval_target: string;
        rollback: string;
        safe_alternative: string;
      };
    };

    expect(payload.classification).toMatchObject({
      decision: "needs_decision",
      risk: "hard-boundary",
      approvalTarget: "operator",
    });
    expect(payload.pendingDecision).toMatchObject({
      action: "deploy release",
      risk: "hard-boundary",
      approval_target: "operator",
    });
    expect(payload.pendingDecision.rollback).toContain("no side effect");
    expect(payload.pendingDecision.safe_alternative).toContain("local review packet");

    const listRuntime = createRuntime();
    await tasksDecisionsListCommand({ json: true }, listRuntime);
    const listPayload = JSON.parse(String(vi.mocked(listRuntime.log).mock.calls[0]?.[0])) as {
      decisions: Array<{ id: string; action: string }>;
      allowed_actions: unknown[];
      loadErrors: string[];
    };
    expect(listPayload.loadErrors).toEqual([]);
    expect(listPayload.decisions).toEqual([
      expect.objectContaining({ id: payload.pendingDecision.id, action: "deploy release" }),
    ]);
    expect(listPayload.allowed_actions).toEqual([]);
  });

  it("fails closed instead of overwriting a malformed pending decision queue", async () => {
    const path = join(tempWorkbenchHome, "status", "pending-decisions.json");
    writeFileSync(path, "{not json", "utf8");

    await expect(
      tasksDecisionsClassifyCommand(
        {
          action: "deploy release",
          title: "Ship package",
          json: true,
        },
        createRuntime(),
      ),
    ).rejects.toThrow("Cannot write pending-decisions.json");
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  it("summarizes durable Run Harness supervision from a supplied run root", async () => {
    const runRoot = mkdtempSync(join(tmpdir(), "openclaw-command-run-harness-"));
    mkdirSync(join(runRoot, "gates"), { recursive: true });
    mkdirSync(join(runRoot, "failures"), { recursive: true });
    mkdirSync(join(runRoot, "receipts"), { recursive: true });
    mkdirSync(join(runRoot, "reviews"), { recursive: true });
    mkdirSync(join(runRoot, "verification"), { recursive: true });
    try {
      writeFileSync(
        join(runRoot, "task-graph.json"),
        JSON.stringify({
          tasks: [{ id: "T005", title: "Supervise durable work", status: "blocked" }],
        }),
      );
      writeFileSync(
        join(runRoot, "stage-manifest.json"),
        JSON.stringify({
          run_id: "run-supervision",
          stages: [{ id: "S005", task_id: "T005", title: "Durable work", status: "pending" }],
          gates: ["G001-source-release"],
        }),
      );
      writeFileSync(join(runRoot, "gates", "G001-source-release.md"), "# Source release\n");
      writeFileSync(join(runRoot, "failures", "T005.md"), "# T005 blocker\nT004 is not ready.\n");
      writeFileSync(join(runRoot, "receipts", "T005.md"), "# T005 receipt\n");
      writeFileSync(join(runRoot, "reviews", "T005.md"), "# T005 review\n");
      writeFileSync(join(runRoot, "verification", "T005.md"), "# T005 verification\n");

      const runtime = createRuntime();
      await tasksSupervisionCommand({ json: true, runRoot }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        runId: string;
        safety: { gatesAutoApproved: boolean };
        blockers: Array<{ kind: string; id: string }>;
        routing: Array<{ lane: string }>;
        evidence: { receipts: string[]; reviews: string[]; verification: string[] };
      };
      expect(payload.runId).toBe("run-supervision");
      expect(payload.safety.gatesAutoApproved).toBe(false);
      expect(payload.routing.map((entry) => entry.lane)).toContain("run-harness");
      expect(payload.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "task", id: "T005" }),
          expect.objectContaining({ kind: "failure", id: "T005" }),
          expect.objectContaining({ kind: "gate", id: "G001-source-release" }),
        ]),
      );
      expect(payload.evidence).toEqual({
        receipts: ["receipts/T005.md"],
        reviews: ["reviews/T005.md"],
        verification: ["verification/T005.md"],
      });
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it("allows low-risk local explicit-scope actions without creating pending decisions", async () => {
    const runtime = createRuntime();

    await tasksDecisionsClassifyCommand(
      {
        action: "update local docs",
        title: "Document local behavior",
        reason: "local reversible documentation update",
        json: true,
      },
      runtime,
    );

    const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
      classification: { decision: string; risk: string; rollback: string };
      allowedAction?: { id: string; action: string; rollback: string };
      pendingDecision?: unknown;
    };

    expect(payload.classification).toMatchObject({
      decision: "allowed",
      risk: "low",
    });
    expect(payload.classification.rollback).toContain("local");
    expect(payload.allowedAction).toEqual(
      expect.objectContaining({
        action: "update local docs",
      }),
    );
    expect(payload.allowedAction?.rollback).toContain("local");
    expect(payload).not.toHaveProperty("pendingDecision");
  });

  it("defaults unknown or dangerous actions to pending decisions", async () => {
    const dangerousActions = [
      "rm -rf /tmp/project",
      "git reset --hard",
      "launchctl load service.plist",
      "kubectl apply -f prod.yaml",
      "terraform apply",
      "scp file remote:/tmp",
      "rsync file remote:/tmp",
      "open browser and do something",
    ];

    for (const action of dangerousActions) {
      const runtime = createRuntime();
      await tasksDecisionsClassifyCommand({ action, title: action, json: true }, runtime);
      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        classification: { decision: string; risk: string };
        pendingDecision?: unknown;
      };
      expect(payload.classification).toMatchObject({
        decision: "needs_decision",
        risk: "hard-boundary",
      });
      expect(payload).toHaveProperty("pendingDecision");
    }
  });

  it("does not false-positive local post-processing or notify policy updates", async () => {
    for (const action of ["post-process local logs", "update task notify policy"]) {
      const runtime = createRuntime();
      await tasksDecisionsClassifyCommand({ action, title: action, json: true }, runtime);
      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        classification: { decision: string; risk: string };
        pendingDecision?: unknown;
      };
      expect(payload.classification).toMatchObject({
        decision: "allowed",
        risk: "low",
      });
      expect(payload).not.toHaveProperty("pendingDecision");
    }
  });

  it("renders local phone probe replies without delivery or hard-boundary continuation", async () => {
    upsertSafeTask({
      taskId: "task-safe-phone",
      title: "Safe local continuation",
      workspace: "/tmp/project",
      allowedActions: ["read_status", "continue_registered_local_task"],
    });
    upsertSafeTask({
      taskId: "task-needs-phone-decision",
      title: "Needs operator approval",
      workspace: "/tmp/project",
    });
    blockSafeTask({
      taskId: "task-needs-phone-decision",
      reason: "External send requires approval",
      needsDecision: true,
    });

    const statusRuntime = createRuntime();
    await tasksPhoneProbeCommand({ text: "你在干啥", json: true }, statusRuntime);
    const statusPayload = JSON.parse(String(vi.mocked(statusRuntime.log).mock.calls[0]?.[0])) as {
      no_delivery: boolean;
      task_count: number;
      pending_decision_count: number;
      continue_candidate_count: number;
      excluded_sources: string[];
    };
    expect(statusPayload).toMatchObject({
      no_delivery: true,
      task_count: 2,
      pending_decision_count: 1,
      continue_candidate_count: 1,
    });
    expect(statusPayload.excluded_sources).toContain("live phone delivery");

    const decisionsRuntime = createRuntime();
    await tasksPhoneProbeCommand({ text: "有什么要确认", json: true }, decisionsRuntime);
    const decisionsPayload = JSON.parse(
      String(vi.mocked(decisionsRuntime.log).mock.calls[0]?.[0]),
    ) as {
      intent: string;
      decisions: Array<{ task_id: string; safe_alternative: string }>;
    };
    expect(decisionsPayload.intent).toBe("decisions");
    expect(decisionsPayload.decisions).toEqual([
      expect.objectContaining({
        task_id: "task-needs-phone-decision",
        safe_alternative: expect.stringContaining("local review packet"),
      }),
    ]);

    const continueRuntime = createRuntime();
    await tasksPhoneProbeCommand({ text: "继续任务", json: true }, continueRuntime);
    const continuePayload = JSON.parse(
      String(vi.mocked(continueRuntime.log).mock.calls[0]?.[0]),
    ) as {
      intent: string;
      continue_candidates: Array<{ task_id: string; risk: string }>;
    };
    expect(continuePayload.intent).toBe("continue");
    expect(continuePayload.continue_candidates).toEqual([
      expect.objectContaining({
        task_id: "task-safe-phone",
        risk: "low",
      }),
    ]);
  });
});
