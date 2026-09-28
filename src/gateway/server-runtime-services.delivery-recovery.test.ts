import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureDeliveryQueueStateContext,
  loadDeliveryQueueEntry,
} from "../infra/delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../infra/outbound/delivery-queue-namespaces.js";
import {
  findDeliveryIntentOwner,
  loadPendingDelivery,
} from "../infra/outbound/delivery-queue-storage.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import * as lifecycleNotices from "./server-restart-sentinel-notice.js";
import { activateGatewayScheduledServices } from "./server-runtime-services.js";
import * as updateRunNotices from "./update-run-notice.runtime.js";
import { startUpdateRunWatcher } from "./update-run-watcher.js";

vi.mock("../infra/heartbeat-runner-scheduler.js", () => ({
  startHeartbeatRunner: () => ({ stop() {}, updateConfig() {} }),
}));
vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: () => ({ stop() {} }),
}));
vi.mock("../infra/session-delivery-queue-runtime.js", () => ({
  startSessionDeliveryRuntime: () => async () => {},
  schedulePendingSessionDeliveries: async () => {},
}));
vi.mock("./server-restart-sentinel.js", () => ({
  recoverPendingRestartContinuationDeliveries: async () => {},
  deliverQueuedSessionDelivery: async () => {},
  settleQueuedSessionDelivery: async () => {},
}));

let services: ReturnType<typeof activateGatewayScheduledServices> | undefined;
let watcher: ReturnType<typeof startUpdateRunWatcher> | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await watcher?.stop();
    await services?.stopDeliveryRecovery();
    services?.heartbeatRunner.stop();
    watcher = undefined;
    services = undefined;
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    cleanup();
  });
});

it("recovers a watcher-owned update notice on its runtime state after ambient root drift", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  resetGatewayWorkAdmission();
  const rootA = tempDirs.make("openclaw-runtime-recovery-a-");
  const rootB = tempDirs.make("openclaw-runtime-recovery-b-");
  vi.stubEnv("OPENCLAW_STATE_DIR", rootA);
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
  const sessionKey = "agent:main:matrix:direct:owner";
  const recipient = "@owner:example.org";
  const cfg: OpenClawConfig = {
    commands: { ownerAllowFrom: [`matrix:${recipient}`] },
    agents: { defaults: { heartbeat: { every: "0m" } } },
    skills: { workshop: { autonomous: { mode: "off" } } },
  };
  setRuntimeConfigSnapshot(cfg);
  const receipts: string[] = [];
  const attempts: Array<{ text: string; stateDir: string | undefined }> = [];
  const plugin = createOutboundTestPlugin({
    id: "matrix",
    outbound: {
      deliveryMode: "direct",
      sendText: async (ctx) => {
        attempts.push({ text: ctx.text, stateDir: process.env.OPENCLAW_STATE_DIR });
        if (attempts.length === 1) {
          vi.stubEnv("OPENCLAW_STATE_DIR", rootB);
          throw new PlatformMessageNotDispatchedError("Synthetic transport did not dispatch", {
            retryable: true,
            cause: new Error("Controlled transport failure before dispatch"),
          });
        }
        await ctx.onPlatformSendDispatch?.();
        ctx.assertDirectAdapterHandoff?.();
        receipts.push(ctx.text);
        return { channel: "matrix", messageId: "recovered-update-notice" };
      },
    },
  });
  setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId: "existing-owner-session",
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState({
        context: { channel: "matrix", to: recipient, accountId: "default" },
      }),
    },
  );
  const contextA = captureDeliveryQueueStateContext();
  const notice = vi.spyOn(lifecycleNotices, "sendGatewayLifecycleNotice");
  const notifyPhase = vi.spyOn(updateRunNotices, "notifyUpdateRunPhase");
  const admittedWork = vi.spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission");
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  services = activateGatewayScheduledServices({
    minimalTestGateway: false,
    cfgAtStart: cfg,
    deps: {},
    sessionDeliveryRecoveryMaxEnqueuedAt: Date.now(),
    cronEnabled: false,
    log: { ...log, child: () => log },
  });
  await vi.dynamicImportSettled();
  const run = createUpdateRun({
    trigger: "chat",
    before: { version: "2026.9.4" },
    target: { version: "2026.9.5" },
    origin: { sessionKey },
  });
  recordUpdateRunStep(run.runId, { step: "notice:ack", status: "completed" });
  const broadcast = vi.fn();
  watcher = startUpdateRunWatcher({ broadcast, log });
  expect(broadcast).toHaveBeenCalledWith(
    "update.run.changed",
    expect.objectContaining({ runId: run.runId, status: "running" }),
  );
  finishUpdateRun(run.runId, { status: "succeeded", after: { version: "2026.9.5" } });
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.dynamicImportSettled();
  // Import settlement does not join the notifier's worker reads or durable handoff.
  expect(notifyPhase).toHaveBeenCalledOnce();
  await notifyPhase.mock.results[0]?.value;
  expect(notice).toHaveBeenCalledOnce();
  const queueId = `update-run-finished:${run.runId}`;
  expect(await loadPendingDelivery(queueId, undefined, contextA)).toMatchObject({
    retryCount: 1,
    attemptCount: 1,
    lastError: expect.stringContaining("Synthetic transport did not dispatch"),
  });
  expect(attempts).toEqual([
    { text: expect.stringContaining("✅ OpenClaw updated"), stateDir: rootA },
  ]);
  const firstAttempt = expectDefined(attempts[0], "Expected failed transport attempt");
  expect(receipts).toEqual([]);

  // The first five-second tick can precede the failed send's backoff deadline.
  await vi.advanceTimersByTimeAsync(10_000);
  await vi.dynamicImportSettled();
  await Promise.all(admittedWork.mock.results.map((result) => result.value));
  expect(attempts).toHaveLength(2);
  expect(await findDeliveryIntentOwner(queueId, undefined, contextA)).toMatchObject({
    status: "completed",
  });
  expect(attempts[1]).toEqual({ text: firstAttempt.text, stateDir: rootB });
  expect(receipts).toEqual([firstAttempt.text]);
  expect(
    loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, rootA, "all", contextA),
  ).toMatchObject({
    id: queueId,
    completionRetention: "permanent",
    recoveryState: "completed_permanent",
  });
  expect(await findDeliveryIntentOwner(queueId, rootB)).toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.dynamicImportSettled();
  await Promise.all(admittedWork.mock.results.map((result) => result.value));
  expect(attempts).toHaveLength(2);
  expect(receipts).toHaveLength(1);
});
