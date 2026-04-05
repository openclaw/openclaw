import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  resolveStorePath,
  saveSessionStore,
} from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { completeTaskRunByRunId, createRunningTaskRun } from "../tasks/task-executor.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  tasksAuditCommand,
  tasksListCommand,
  tasksMaintenanceCommand,
  tasksShowCommand,
} from "./tasks.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

async function withTaskCommandStateDir(run: () => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-tasks-command-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    clearSessionStoreCacheForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
    try {
      await run();
    } finally {
      clearSessionStoreCacheForTest();
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
    }
  });
}

describe("tasks commands", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    clearSessionStoreCacheForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("keeps tasks audit JSON stable while adding TaskFlow summary fields", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 40 * 60_000);
      createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-stale-queued",
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
        findings: Array<{
          kind: string;
          code: string;
          token?: string;
          lifecycleReason?: {
            code: string;
            evidence?: string;
            summary?: string;
            backing?: unknown;
          };
        }>;
      };

      expect(payload.summary.byCode.stale_running).toBe(1);
      expect(payload.summary.taskFlows.byCode.stale_waiting).toBe(1);
      expect(payload.summary.taskFlows.byCode.missing_linked_tasks).toBe(1);
      expect(payload.summary.combined.total).toBe(3);
      expect(payload.findings.find((finding) => finding.kind === "task")).toMatchObject({
        kind: "task",
        code: "stale_running",
        token: expect.any(String),
        lifecycleReason: {
          code: "stale_running",
          evidence: "running task appears stuck",
          backing: {
            kind: "task",
            taskId: expect.any(String),
            runId: "task-stale-queued",
          },
        },
      });
      expect(payload.findings.find((finding) => finding.kind === "task_flow")).toMatchObject({
        kind: "task_flow",
        code: "stale_waiting",
        token: expect.any(String),
        lifecycleReason: {
          code: "waiting",
          summary: expect.any(String),
          backing: expect.arrayContaining([
            expect.objectContaining({ kind: "session", relation: "owner_session" }),
          ]),
        },
      });
    });
  });

  it("adds lifecycle reasons to tasks list JSON output", async () => {
    await withTaskCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Inspect lifecycle bridge",
        status: "running",
      });
      createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-running-1",
        task: "Inspect lifecycle bridge",
        progressSummary: "Collecting task status evidence",
        childSessionKey: "agent:main:child-1",
        parentFlowId: flow.flowId,
      });
      const storePath = resolveStorePath(undefined, { agentId: "main" });
      await saveSessionStore(storePath, {
        "agent:main:child-1": {
          sessionId: "session-child-1",
          updatedAt: Date.now(),
          status: "running",
        },
      });
      clearSessionStoreCacheForTest();

      const runtime = createRuntime();
      await tasksListCommand({ json: true }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        tasks: Array<{
          runId?: string;
          statusReason?: {
            code: string;
            summary: string;
            backing?: Array<{ kind: string; relation: string; id: string }>;
          };
        }>;
      };

      expect(payload.tasks).toHaveLength(1);
      expect(payload.tasks[0]).toMatchObject({
        runId: "task-running-1",
        statusReason: {
          code: "running",
          summary: "Collecting task status evidence",
          backing: expect.arrayContaining([
            { kind: "flow", relation: "parent_flow", id: flow.flowId },
            { kind: "session", relation: "child_session", id: "agent:main:child-1" },
          ]),
        },
      });
    });
  });

  it("shows lifecycle reason and links in task detail output", async () => {
    await withTaskCommandStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Resume gated command",
        status: "running",
      });
      const task = createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-blocked-1",
        task: "Resume gated command",
        childSessionKey: "agent:main:child-2",
        parentFlowId: flow.flowId,
      });
      completeTaskRunByRunId({
        runId: "task-blocked-1",
        endedAt: Date.now(),
        terminalOutcome: "blocked",
        terminalSummary: "Writable session approval required.",
      });

      const runtime = createRuntime();
      await tasksShowCommand({ lookup: task.taskId }, runtime);

      const output = vi
        .mocked(runtime.log)
        .mock.calls.map((call) => String(call[0]))
        .join("\n");

      expect(output).toContain("reason: Writable session approval required.");
      expect(output).toContain("links: linked flow · child session");
    });
  });

  it("adds lifecycle reason to tasks show JSON output", async () => {
    await withTaskCommandStateDir(async () => {
      const task = createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-show-json-1",
        task: "Inspect lost child session",
        childSessionKey: "agent:main:child-3",
      });

      const runtime = createRuntime();
      await tasksShowCommand({ json: true, lookup: task.taskId }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        taskId: string;
        statusReason?: {
          code: string;
          summary: string;
          backing?: Array<{ kind: string; relation: string; id: string }>;
        };
      };

      expect(payload).toMatchObject({
        taskId: task.taskId,
        statusReason: {
          code: "missing_backing_session",
          summary: "Backing session is missing; task may be orphaned.",
          backing: expect.arrayContaining([
            { kind: "session", relation: "child_session", id: "agent:main:child-3" },
          ]),
        },
      });
    });
  });

  it("surfaces blocked backing-session state in task detail JSON before registry reconciliation", async () => {
    await withTaskCommandStateDir(async () => {
      const task = createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-show-json-backed-failed",
        task: "Inspect child session failure",
        childSessionKey: "agent:main:subagent:child-failed-json",
      });
      const storePath = resolveStorePath(undefined, { agentId: "main" });
      await saveSessionStore(storePath, {
        "agent:main:subagent:child-failed-json": {
          sessionId: "session-child-failed-json",
          updatedAt: Date.now(),
          status: "failed",
        },
      });
      clearSessionStoreCacheForTest();

      const runtime = createRuntime();
      await tasksShowCommand({ json: true, lookup: task.taskId }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        taskId: string;
        statusReason?: {
          code: string;
          summary: string;
          evidence?: Array<{ kind: string; data?: Record<string, string> }>;
        };
      };

      expect(payload).toMatchObject({
        taskId: task.taskId,
        statusReason: {
          code: "blocked_on_backing_session_state",
          summary: "Backing session failed; task has not reconciled yet.",
          evidence: expect.arrayContaining([
            expect.objectContaining({
              kind: "session_state",
              data: {
                state: "failed",
                source: "session_status",
              },
            }),
          ]),
        },
      });
    });
  });

  it("sorts combined audit findings before applying the limit", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 40 * 60_000);
      createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-stale-queued",
        task: "Queue audit",
      });
      vi.setSystemTime(now);
      const runningFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Running flow",
        status: "running",
        createdAt: now - 45 * 60_000,
        updatedAt: now - 45 * 60_000,
      });

      const runtime = createRuntime();
      await tasksAuditCommand({ json: true, limit: 1 }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        findings: Array<{ kind: string; code: string; token?: string }>;
      };

      expect(payload.findings).toHaveLength(1);
      expect(payload.findings[0]).toMatchObject({
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
      expect(payload.auditBefore.byCode).toBeDefined();
      expect(payload.auditBefore.taskFlows.byCode.stale_running).toBe(0);
      expect(payload.auditAfter.byCode).toBeDefined();
      expect(payload.auditAfter.taskFlows.byCode.stale_running).toBe(0);
    });
  });
});
