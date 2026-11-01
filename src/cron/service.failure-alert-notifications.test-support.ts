import { vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { completionConfig } from "../agents/bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import type { SessionEventReceipt } from "../auto-reply/reply/session-event-contract.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { CronJobCreate } from "../cron/types.js";
import { createGatewayCronTargetResolver } from "../gateway/server-cron-targets.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";

// mock-isolation: Rejected transport, model output, and final channel I/O are fixed fixtures;
// fallback admission, Gateway target capture, tools, and session execution are real.
vi.mock("../agents/embedded-agent-runner/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/embedded-agent-runner/run.js")>()),
  runEmbeddedAgent: vi.fn(),
}));
export const failureAlertModel = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

export async function setupFailureAlertNotificationFixture(
  state: OpenClawTestState,
  params: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    originDeliveryContext?: DeliveryContext;
    sessionDeliveryContext?: DeliveryContext;
    telegram?: true;
  },
) {
  const cfg = completionConfig(state.workspaceDir);
  cfg.agents!.entries![params.agentId] = { workspace: state.workspaceDir };
  cfg.agents!.entries!.ops = { workspace: state.workspaceDir };
  setRuntimeConfigSnapshot(cfg);
  await state.writeConfig(cfg);
  openOpenClawStateDatabase();
  await replaceSessionEntry(
    { agentId: params.agentId, sessionKey: params.sessionKey },
    {
      sessionId: params.sessionId,
      lifecycleRevision: "original",
      permissionMode: "full",
      ...(params.sessionDeliveryContext
        ? { delivery: normalizeSessionDeliveryState({ context: params.sessionDeliveryContext }) }
        : {}),
      updatedAt: Date.now(),
    },
  );

  const registry = params.telegram ? captureActivePluginRegistrySnapshot() : undefined;
  const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>().mockResolvedValue({
    channel: "telegram",
    messageId: "failure-alert-fixture",
  });
  if (registry) {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: {
              normalizeTarget: (raw) => raw,
              targetResolver: { looksLikeId: (raw) => raw === "999" },
            },
            outbound: { deliveryMode: "direct", sendText },
          } satisfies ChannelPlugin,
        },
      ]),
    );
  }

  const receipts: SessionEventReceipt[] = [];
  const notification = createDeferred();
  const enqueue = sessionEvents.enqueueSessionEventForHost;
  const observer = vi
    .spyOn(sessionEvents, "enqueueSessionEventForHost")
    .mockImplementation((...args) => {
      const receipt = enqueue(...args);
      receipts.push(receipt);
      notification.resolve();
      return receipt;
    });
  const logger = createNoopLogger();
  const adapter = createGatewayCronTargetResolver(state.env, logger);
  const failRun = async () => ({
    status: "error" as const,
    error: "temporary upstream error",
  });
  const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
    async (alert) => {
      await alert.onDeliverySettled({
        delivered: false,
        status: "not-delivered",
        error: "failure alert channel unavailable",
      });
      throw new Error("failure alert channel unavailable");
    },
  );
  const deps = cronTestDeps({
    storePath: state.statePath("cron", "jobs.json"),
    cronEnabled: false,
    cronConfig: { failureAlert: { enabled: true, after: 1 } },
    defaultAgentId: "main",
    log: logger,
    ...(params.originDeliveryContext
      ? { resolveOriginDeliveryContext: async () => params.originDeliveryContext }
      : {}),
    enqueueSessionEvent: adapter.enqueueSessionEvent,
    sendCronFailureAlert,
    runIsolatedAgentJob: failRun,
    runSessionEvent: failRun,
  });
  const cron = new CronService(deps);
  await cron.start();

  return {
    deps,
    receipts,
    sendText,
    async run(jobInput: Partial<CronJobCreate>, signal: AbortSignal) {
      const job = await cron.add({
        ...cronTestInput(),
        name: "Important report",
        ...jobInput,
      });
      await cron.run(job.id, "force");
      await withinTest(notification.promise, signal);
    },
    async close() {
      cron.stop();
      for (const receipt of receipts) {
        receipt.cancel();
      }
      await Promise.allSettled([cron.waitForIdle(), ...receipts.map((receipt) => receipt.settled)]);
      observer.mockRestore();
      await drainGlobalSingletonLifecycleState("restart");
      resetSystemEventsForTest();
      if (registry) {
        restoreActivePluginRegistrySnapshot(registry);
      }
    },
  };
}
