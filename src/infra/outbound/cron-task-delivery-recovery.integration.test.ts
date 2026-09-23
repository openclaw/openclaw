import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { retryTransientDirectCronDelivery } from "../../cron/isolated-agent/delivery-dispatch-policy.js";
import { createCronServiceState } from "../../cron/service/state.js";
import { tryFinishCronTaskRun } from "../../cron/service/task-runs.js";
import type { CronJob } from "../../cron/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { createRunningTaskRunCore } from "../../tasks/task-executor.js";
import { getTaskById } from "../../tasks/task-registry.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../../tasks/task-registry.store.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createInMemoryTaskRegistryStore } from "../../test-utils/task-registry-store.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { createCommandCronDeliveryCustody } from "./delivery-completion.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import {
  drainPendingDeliveriesCore,
  recoverPendingDeliveries,
  type DeliverFn,
} from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("command cron delivery recovery", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let stateDir: string;
  let taskStore: ReturnType<typeof createInMemoryTaskRegistryStore>;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    stateDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetTaskRegistryForTests({ persist: false });
    taskStore = createInMemoryTaskRegistryStore();
    configureTaskRegistryRuntime({ store: taskStore });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("restores serialized custody and settles the exact task after restart", async () => {
    const runId = "cron:job-recovery:1000:receipt-recovery";
    const task = createRunningTaskRunCore({
      runtime: "cron",
      sourceId: "job-recovery",
      ownerKey: "",
      scopeKind: "system",
      agentId: "main",
      runId,
      task: "recover command delivery",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt: 1_000,
    })!;
    const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ text: "recover once" }],
        queuePolicy: "required",
        deliveryCompletion: custody.deliveryCompletion,
        completionRetention: custody.completionRetention,
      },
      custody.deliveryIntentId,
      stateDir,
    );

    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({ store: taskStore });
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "synthetic-message" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );

    await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver,
      log: createRecoveryLog(),
      stateDir,
    });

    expect(deliver).toHaveBeenCalledOnce();
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(getTaskById(task.taskId)).toMatchObject({
      runId,
      deliveryStatus: "delivered",
      detail: {
        deliveryEvidence: { intentId: custody.deliveryIntentId, state: "delivered" },
      },
    });
  });

  it("recovers the selected durable task root when the ambient root differs", async () => {
    resetTaskRegistryForTests({ persist: false });
    const selectedStateDir = stateDir;
    const runId = "cron:job-selected-root:1000:receipt-selected-root";
    const task = createRunningTaskRunCore({
      runtime: "cron",
      sourceId: "job-selected-root",
      ownerKey: "",
      scopeKind: "system",
      agentId: "main",
      runId,
      task: "recover selected root",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt: 1_000,
    })!;
    const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!synthetic:selected-root",
        payloads: [{ text: "recover selected root" }],
        queuePolicy: "required",
        deliveryCompletion: custody.deliveryCompletion,
        completionRetention: custody.completionRetention,
      },
      custody.deliveryIntentId,
      selectedStateDir,
    );

    resetTaskRegistryForTests({ persist: false });
    const ambientStateDir = path.join(selectedStateDir, "ambient-root");
    fs.mkdirSync(ambientStateDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = ambientStateDir;
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "synthetic-selected-root" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );

    await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver,
      log: createRecoveryLog(),
      stateDir: selectedStateDir,
    });

    expect(deliver).toHaveBeenCalledOnce();
    expect(sendMatrix).toHaveBeenCalledOnce();
    const selectedContext = captureOpenClawStateWorkerContext({
      env: { ...process.env, OPENCLAW_STATE_DIR: selectedStateDir },
    });
    const snapshot = await getTaskRegistryStore().loadMutationSnapshotAsync(selectedContext, {
      taskId: task.taskId,
    });
    expect(snapshot.tasks.get(task.taskId)).toMatchObject({
      deliveryStatus: "delivered",
      detail: {
        deliveryEvidence: { intentId: custody.deliveryIntentId, state: "delivered" },
      },
    });
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_QUEUE_NAME,
        custody.deliveryIntentId,
        selectedStateDir,
      ),
    ).toBe("completed");
  });

  it("reuses the pending command intent after a proven no-send and then succeeds", async () => {
    const runId = "cron:job-retry:1000:receipt-retry";
    const task = createRunningTaskRunCore({
      runtime: "cron",
      sourceId: "job-retry",
      ownerKey: "",
      scopeKind: "system",
      agentId: "main",
      runId,
      task: "retry command delivery",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt: 1_000,
    })!;
    const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });
    const sendText = vi
      .fn()
      .mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("synthetic pre-send refusal", {
          cause: new Error("synthetic transport unavailable"),
        }),
      )
      .mockResolvedValueOnce({ channel: "matrix", messageId: "synthetic-retry-message" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    await expect(
      retryTransientDirectCronDelivery({
        jobId: "job-retry",
        run: () =>
          deliverOutboundPayloads({
            cfg: {} as OpenClawConfig,
            channel: "matrix",
            to: "!synthetic:example",
            payloads: [{ text: "retry once" }],
            deps: {},
            queuePolicy: "required",
            deliveryQueueStateDir: stateDir,
            deliveryIntentId: custody.deliveryIntentId,
            deliveryCompletion: custody.deliveryCompletion,
            completionRetention: custody.completionRetention,
            reusePendingDeliveryIntent: true,
          }),
      }),
    ).resolves.toMatchObject([{ messageId: "synthetic-retry-message" }]);

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(getTaskById(task.taskId)).toMatchObject({
      deliveryStatus: "delivered",
      detail: { deliveryEvidence: { state: "delivered" } },
    });
  });

  it("keeps retry-exhausted custody pending through cron finalization and recovery", async () => {
    const startedAt = 1_000;
    const runId = "cron:job-retry-exhausted:1000:receipt-retry-exhausted";
    const job: CronJob = {
      id: "job-retry-exhausted",
      name: "retry exhausted command delivery",
      enabled: true,
      createdAtMs: 100,
      updatedAtMs: 100,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "work" },
      state: { nextRunAtMs: 60_000 },
    };
    const task = createRunningTaskRunCore({
      runtime: "cron",
      sourceId: job.id,
      ownerKey: "",
      scopeKind: "system",
      agentId: "main",
      runId,
      task: "retry exhausted command delivery",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt,
    })!;
    const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });
    const notDispatched = () =>
      new PlatformMessageNotDispatchedError("synthetic pre-send refusal", {
        cause: new Error("synthetic transport unavailable"),
      });
    const sendText = vi
      .fn()
      .mockRejectedValueOnce(notDispatched())
      .mockRejectedValueOnce(notDispatched())
      .mockRejectedValueOnce(notDispatched())
      .mockRejectedValueOnce(notDispatched())
      .mockResolvedValueOnce({ channel: "matrix", messageId: "synthetic-recovered-message" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );
    const deliver = () =>
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!synthetic:retry-exhausted",
        payloads: [{ text: "recover after finalization" }],
        deps: {},
        queuePolicy: "required",
        deliveryQueueStateDir: stateDir,
        deliveryIntentId: custody.deliveryIntentId,
        deliveryCompletion: custody.deliveryCompletion,
        completionRetention: custody.completionRetention,
        reusePendingDeliveryIntent: true,
      });

    await expect(retryTransientDirectCronDelivery({ jobId: job.id, run: deliver })).rejects.toThrow(
      "synthetic pre-send refusal",
    );
    expect(sendText).toHaveBeenCalledTimes(4);
    expect(getTaskById(task.taskId)).toMatchObject({
      deliveryStatus: "pending",
      detail: { deliveryEvidence: { state: "queued" } },
    });

    const cronState = createCronServiceState({
      storePath: path.join(stateDir, "cron", "jobs.json"),
      cronEnabled: true,
      defaultAgentId: "main",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => startedAt + 100,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    tryFinishCronTaskRun(cronState, {
      taskRunId: runId,
      job,
      event: {
        jobId: job.id,
        action: "finished",
        job,
        status: "error",
        completionStatus: "unknown",
        error: "synthetic direct delivery retry exhausted",
        delivered: false,
        deliveryStatus: "not-delivered",
        runAtMs: startedAt,
        durationMs: 100,
      },
    });

    expect(getTaskById(task.taskId)).toMatchObject({
      deliveryStatus: "pending",
      detail: {
        deliveryStatus: "unknown",
        deliveryEvidence: { intentId: custody.deliveryIntentId, state: "queued" },
      },
    });

    await drainPendingDeliveriesCore({
      drainKey: "cron-retry-exhausted-test",
      logLabel: "cron retry exhausted test drain",
      cfg: {} as OpenClawConfig,
      deliver: (params) => deliverOutboundPayloads({ ...params, deps: {} }),
      log: createRecoveryLog(),
      stateDir,
      selectEntry: (entry) => ({
        match: entry.id === custody.deliveryIntentId,
        bypassBackoff: true,
      }),
    });

    expect(sendText).toHaveBeenCalledTimes(5);
    expect(getTaskById(task.taskId)).toMatchObject({
      deliveryStatus: "delivered",
      detail: {
        deliveryStatus: "delivered",
        deliveryEvidence: { intentId: custody.deliveryIntentId, state: "delivered" },
      },
    });
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, custody.deliveryIntentId, stateDir),
    ).toBe("completed");
  });

  it("retains queue custody when task evidence storage is unavailable", async () => {
    const runId = "cron:job-storage:1000:receipt-storage";
    const task = createRunningTaskRunCore({
      runtime: "cron",
      sourceId: "job-storage",
      ownerKey: "",
      scopeKind: "system",
      agentId: "main",
      runId,
      task: "retain command delivery",
      deliveryStatus: "pending",
      notifyPolicy: "silent",
      startedAt: 1_000,
    })!;
    const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });
    taskStore.runInitialMutationAsync = async () => {
      throw new Error("synthetic task storage unavailable");
    };
    const sendMatrix = vi.fn();

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ text: "retain custody" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryQueueStateDir: stateDir,
        deliveryIntentId: custody.deliveryIntentId,
        deliveryCompletion: custody.deliveryCompletion,
        completionRetention: custody.completionRetention,
        reusePendingDeliveryIntent: true,
      }),
    ).rejects.toThrow("synthetic task storage unavailable");

    expect(sendMatrix).not.toHaveBeenCalled();
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, custody.deliveryIntentId, stateDir),
    ).toBe("pending");
  });
});
