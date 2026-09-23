import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type {
  DetachedRunningTaskCreateParams,
  DetachedTaskFinalizeParams,
  DetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime-contract.js";
import { createRunningTaskRun, finalizeTaskRunByRunId } from "../../tasks/detached-task-runtime.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  coreCreate:
    vi.fn<
      typeof import("../../tasks/task-executor-create.async.js").createRunningTaskRunCoreWithReceiptAsync
    >(),
  agentCommand: vi.fn<() => Promise<{ payloads: []; meta: Record<string, never> }>>(),
}));
vi.mock("../../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: vi.fn(),
  resolveAgentMainSessionKey: vi.fn(),
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({ readAcpSessionMeta: vi.fn() }));
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", () => ({
  getLatestLiveSubagentRunByChildSessionKey: vi.fn(),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.agentCommand }));
vi.mock("../../runtime.js", () => ({ defaultRuntime: {} }));
vi.mock("../../plugins/runtime/generation-scope.js", () => ({
  getPluginRuntimeGenerationRegistry: () => undefined,
}));
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ warn: vi.fn() }) }));
vi.mock("../../tasks/runtime-internal.js", () => ({
  getTaskById: vi.fn(),
  findTaskByRunId: vi.fn(),
  cancelTaskById: vi.fn(),
}));
vi.mock("../../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: vi.fn(),
  listTasksForSessionKeyForStatus: vi.fn(),
}));
vi.mock("../../tasks/task-executor.js", () => ({
  completeTaskRunByRunIdCore: vi.fn(),
  createQueuedTaskRunCore: vi.fn(),
  createRunningTaskRunCore: vi.fn(),
  failTaskRunByRunIdCore: vi.fn(),
  finalizeTaskRunByRunIdCore: vi.fn(),
  recordTaskRunProgressByRunIdCore: vi.fn(),
  setDetachedTaskDeliveryStatusByRunIdCore: vi.fn(),
  startTaskRunByRunIdCore: vi.fn(),
}));
vi.mock("../../tasks/task-executor-create.async.js", () => ({
  createRunningTaskRunCoreWithReceiptAsync: mocks.coreCreate,
}));
vi.mock("../../tasks/task-flow-registry.store.sqlite.js", () => ({
  bindTaskFlowExecution: vi.fn(),
}));
vi.mock("../../tasks/task-registry.store.sqlite.js", () => ({ bindTaskRunExecution: vi.fn() }));
vi.mock("../../tasks/task-run-owner.js", () => ({
  bindTaskRunOwner: () => {
    mocks.events.push("bind-owner");
    return () => {};
  },
  getTaskRunOwner: () => undefined,
}));
vi.mock(import("../../infra/agent-run-registry.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  clearAgentRunContext: vi.fn(),
  validateAgentRunDelegatedAuthority: () => true,
}));
vi.mock(import("../../infra/agent-events.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  isAgentEventLifecycleGenerationCurrent: () => true,
}));
vi.mock("../../agents/cron-creator-authority-context.js", () => ({
  createCronCreatorAuthorityCapability: () => ({}),
  runWithCronCreatorAuthorityCapability: (_scope: unknown, run: () => unknown) => run(),
}));
vi.mock("../chat-abort-ops.js", () => ({ createChatAbortOps: vi.fn() }));
vi.mock("../chat-abort.js", () => ({ abortChatRunById: vi.fn() }));
vi.mock("./agent-dedupe.js", () => ({ setGatewayDedupeEntries: vi.fn() }));

// Opaque V1 storage intentionally supports a run-scoped write to matching sibling rows.
class LegacyOwner implements DetachedTaskLifecycleRuntime {
  #rows = new Map<string, TaskRecord>();
  #template: TaskRecord;
  calls: string[] = [];
  afterFinalize?: () => void;
  constructor(task: TaskRecord) {
    this.#template = task;
  }
  get rows() {
    return [...this.#rows.values()];
  }
  createRunningTaskRun(input: DetachedRunningTaskCreateParams) {
    mocks.events.push("create");
    const task = { ...this.#template, runId: input.runId };
    this.#rows.set(task.taskId, task);
    this.#rows.set("sibling", { ...task, taskId: "sibling" });
    return structuredClone(task);
  }
  createQueuedTaskRun() {
    return null;
  }
  startTaskRunByRunId() {
    return [];
  }
  recordTaskRunProgressByRunId() {
    return [];
  }
  setDetachedTaskDeliveryStatusByRunId() {
    return [];
  }
  async cancelDetachedTaskRunById() {
    return { found: false, cancelled: false };
  }
  #finish(input: DetachedTaskFinalizeParams, method: string) {
    this.calls.push(method);
    const rows = this.rows.filter((task) => task.runId === input.runId);
    for (const row of rows) {
      row.status = input.status;
      row.endedAt = input.endedAt;
    }
    this.afterFinalize?.();
    return rows.map((row) => structuredClone(row));
  }
  finalizeTaskRunByRunId: DetachedTaskLifecycleRuntime["finalizeTaskRunByRunId"] = function (
    this: LegacyOwner,
    input,
  ) {
    return this.#finish(input, "finalize");
  };
  completeTaskRunByRunId(
    input: Parameters<DetachedTaskLifecycleRuntime["completeTaskRunByRunId"]>[0],
  ) {
    return this.#finish({ ...input, status: "succeeded" }, "complete");
  }
  failTaskRunByRunId(input: Parameters<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]>[0]) {
    return this.#finish({ ...input, status: input.status ?? "failed" }, "fail");
  }
}

async function withOwner(
  run: (context: {
    fixture: ReturnType<typeof createTrackedDispatch>;
    backend: LegacyOwner;
    registry: ReturnType<typeof createEmptyPluginRegistry>;
    replace: () => LegacyOwner;
  }) => Promise<void>,
  registered = true,
) {
  const fixture = createTrackedDispatch();
  const backend = new LegacyOwner(fixture.task);
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "legacy",
    source: "/plugins/legacy/index.js",
    origin: "config",
    enabled: true,
    configSchema: true,
  });
  registry.plugins.push(record);
  if (registered) {
    registry.detachedTaskRuntimes.push({ pluginId: record.id, runtime: backend });
  }
  const replace = () => {
    const successor = new LegacyOwner(fixture.task);
    registry.detachedTaskRuntimes.splice(0, registry.detachedTaskRuntimes.length, {
      pluginId: record.id,
      runtime: successor,
    });
    return successor;
  };
  markPluginRegistryActive(registry);
  try {
    await withPluginRuntimeRegistryScope(registry, () =>
      run({ fixture, backend, registry, replace }),
    );
  } finally {
    markPluginRegistryRetired(registry);
  }
}

function dispatch(
  fixture: ReturnType<typeof createTrackedDispatch>,
  bindRunScope: () => void = () => {},
  taskTrackingMode: "cli" | "none" = "cli",
  emitFinal = vi.fn<Parameters<typeof dispatchAgentRunFromGateway>[0]["io"]["emitFinal"]>(),
  onSettled?: Parameters<typeof dispatchAgentRunFromGateway>[0]["onSettled"],
) {
  return dispatchAgentRunFromGateway({
    ingressOpts: {
      message: fixture.task.task,
      sessionKey: fixture.sessionKey,
      allowModelOverride: false,
    },
    runId: fixture.runId,
    dedupeKeys: [],
    admittedRunEntry: fixture.entry,
    abortController: fixture.entry.controller,
    cleanupAbortController: vi.fn(),
    io: { emitAcceptance: vi.fn(), emitFinal },
    context: fixture.context,
    taskTrackingMode,
    assertSettlementCurrent() {},
    onSettled,
    cronCreatorAuthority: { runId: fixture.runId, callerOrigin: { kind: "unknown" }, bindRunScope },
  });
}

describe("Gateway synchronous task owner compatibility", () => {
  beforeEach(() => {
    mocks.events.length = 0;
    mocks.coreCreate.mockReset();
    mocks.agentCommand.mockReset();
    mocks.agentCommand.mockImplementation(async () => {
      mocks.events.push("command");
      throw new Error("Command failed before execution started");
    });
  });

  it.each([
    { fallback: false, failed: true },
    { fallback: true, failed: true },
    { fallback: false, failed: false },
    { fallback: true, failed: false },
  ])(
    "preserves synchronous ordering and run-scoped cleanup (fallback=$fallback, failed=$failed)",
    async ({ fallback, failed }) =>
      withOwner(async ({ fixture, backend }) => {
        if (fallback) {
          backend.finalizeTaskRunByRunId = undefined;
        }
        if (!failed) {
          mocks.agentCommand.mockImplementation(async () => {
            mocks.events.push("command");
            return { payloads: [], meta: {} };
          });
        }
        let finalizedMicrotask = false;
        backend.afterFinalize = () => {
          queueMicrotask(() => {
            finalizedMicrotask = true;
          });
        };
        const onSettled = vi.fn(() => {
          expect(finalizedMicrotask).toBe(false);
          return true;
        });
        const completion = dispatch(
          fixture,
          () => {
            mocks.events.push("bind-scope");
            expect(backend.rows).toHaveLength(2);
          },
          "cli",
          undefined,
          onSettled,
        );
        expect(mocks.events).toEqual(["create", "bind-scope", "command", "bind-owner"]);
        await completion;
        expect(onSettled).toHaveReturnedWith(true);
        expect(backend.calls).toEqual([fallback ? (failed ? "fail" : "complete") : "finalize"]);
        expect(backend.rows.map((task) => task.status)).toEqual([
          failed ? "failed" : "succeeded",
          failed ? "failed" : "succeeded",
        ]);
        expect(mocks.coreCreate).not.toHaveBeenCalled();
      }),
  );

  it.each(["setup", "command", "retirement"] as const)(
    "never redirects legacy terminal writes after %s owner replacement",
    async (phase) =>
      withOwner(async ({ fixture, backend, registry, replace }) => {
        let successor: LegacyOwner | undefined;
        mocks.agentCommand.mockImplementation(async () => {
          if (phase === "command") {
            successor = replace();
          }
          if (phase === "retirement") {
            markPluginRegistryRetired(registry);
          }
          throw new Error("Startup failed");
        });
        await dispatch(fixture, () => {
          if (phase === "setup") {
            successor = replace();
          }
        });
        expect(backend.rows).toHaveLength(2);
        expect(backend.rows.every((task) => task.status === "running")).toBe(true);
        expect(backend.calls).toEqual([]);
        expect(successor?.calls ?? []).toEqual([]);
        expect(successor?.rows ?? []).toEqual([]);
        expect(fixture.context.logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining("failed to finalize tracked agent task"),
        );
      }),
  );

  it.each(["throw", "replace"] as const)(
    "does not start modern creation when setup callbacks %s",
    async (change) =>
      withOwner(async ({ fixture, replace }) => {
        if (change === "throw") {
          expect(() =>
            dispatch(fixture, () => {
              throw new Error("Setup refused");
            }),
          ).toThrow("Setup refused");
          expect(mocks.agentCommand).not.toHaveBeenCalled();
        } else {
          let successor: LegacyOwner | undefined;
          const completion = dispatch(fixture, () => {
            successor = replace();
          });
          await completion;
          expect(successor?.rows).toEqual([]);
        }
        expect(mocks.coreCreate).not.toHaveBeenCalled();
      }, false),
  );

  it("does not introduce a preparation yield when tracking is disabled", async () =>
    withOwner(async ({ fixture, backend }) => {
      const completion = dispatch(fixture, () => mocks.events.push("bind-scope"), "none");
      expect(mocks.events).toEqual(["bind-scope", "command"]);
      await completion;
      expect(backend.rows).toEqual([]);
      expect(mocks.coreCreate).not.toHaveBeenCalled();
    }));

  it.each(["Primitive command failure", 42])(
    "retains the rendered message and original cause for synchronous throw %s",
    async (failure) =>
      withOwner(async ({ fixture, backend }) => {
        mocks.agentCommand.mockImplementation(() => {
          // oxlint-disable-next-line typescript/only-throw-error -- Verify primitive JavaScript throws through the Gateway terminal response.
          throw failure;
        });
        const emitFinal =
          vi.fn<Parameters<typeof dispatchAgentRunFromGateway>[0]["io"]["emitFinal"]>();
        await dispatch(fixture, () => {}, "cli", emitFinal);
        expect(emitFinal).toHaveBeenCalledWith(
          [
            false,
            expect.objectContaining({ status: "error", summary: String(failure) }),
            expect.objectContaining({
              message: String(failure),
              cause: expect.objectContaining({ cause: failure }),
            }),
          ],
          expect.objectContaining({ error: String(failure) }),
        );
        expect(backend.calls).toEqual(["finalize"]);
        expect(backend.rows.every((task) => task.status === "failed")).toBe(true);
      }),
  );

  it("keeps shipped synchronous entry points usable through the selected owner", async () =>
    withOwner(async ({ fixture, backend }) => {
      expect(
        createRunningTaskRun({ runtime: "cli", task: "Direct", runId: fixture.runId })?.taskId,
      ).toBe(fixture.task.taskId);
      const result = finalizeTaskRunByRunId({
        runId: fixture.runId,
        status: "failed",
        endedAt: 10,
      });
      expect(result).toHaveLength(2);
      expect(backend.calls).toEqual(["finalize"]);
    }));
});
