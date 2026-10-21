import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { admitModelTurn, completionConfig } from "../agents/bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService, type CronEvent } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { abortActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import type { CronServiceDeps } from "./service/state.js";
import { runCronSessionTurn } from "./session-run.js";
import { cronStoreKey } from "./store/key.js";

// mock-isolation: Only model and channel I/O are synthetic; admission, delivery and receipts stay real.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

const scope = { agentId: "main", sessionKey: "agent:main:main" };

async function prepareCronSessionFixture(state: OpenClawTestState, onQueued?: () => void) {
  const config = completionConfig(state.workspaceDir);
  setRuntimeConfigSnapshot(config);
  await state.writeConfig(config);
  openOpenClawStateDatabase();
  await replaceSessionEntry(scope, {
    sessionId: "cron-restart-session",
    lifecycleRevision: "original",
    permissionMode: "full",
    updatedAt: Date.now(),
  });
  const storePath = state.statePath("cron", "jobs.json");
  const deps: Omit<CronServiceDeps, "scheduler"> = {
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    log: createNoopLogger(),
    resolveSessionEventTarget: () => scope,
    runSessionEvent: (params) =>
      runCronSessionTurn({
        ...params,
        ...scope,
        cfg: config,
        onLaneWait(info) {
          params.onLaneWait?.(info);
          if (info?.waiting) {
            onQueued?.();
          }
        },
      }),
    enqueueSystemEvent: () => {
      throw new Error("Main-session events must use the session controller");
    },
    requestHeartbeat: () => {
      throw new Error("Main-session events must not wake the retired executor");
    },
    runIsolatedAgentJob: async () => {
      throw new Error("Main-session events must not use an isolated session");
    },
  };
  return {
    createService: (onEvent?: CronServiceDeps["onEvent"]) =>
      new CronService({ ...deps, onEvent, scheduler: createTestGatewayScheduler() }),
    history: (jobId: string) =>
      readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId }).entries,
  };
}

async function enqueueForeground(text: string, signal: AbortSignal) {
  return enqueueSessionEventForHost(text, {
    ...scope,
    source: "task",
    expectedTarget: await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey),
    abortSignal: signal,
    deliver: false,
  });
}

it.for(["next-heartbeat", "now"] as const)(
  "records an unadopted %s event as interrupted once across restart",
  async (wakeMode, { signal }) => {
    await withOpenClawTestState(
      { label: "cron-event-restart", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const queued = createDeferred();
        const { createService, history } = await prepareCronSessionFixture(state, queued.resolve);
        const first = createService();
        const foregroundStarted = createDeferred();
        const releaseForeground = createDeferred();
        const prompts: string[] = [];
        runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
          prompts.push(params.prompt);
          await admitModelTurn(params);
          if (prompts.length === 1) {
            foregroundStarted.resolve();
            await releaseForeground.promise;
          }
          return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
        });
        const foreground = await enqueueForeground("Synthetic foreground work", signal);
        let replacement: CronService | undefined;
        let running: ReturnType<CronService["run"]> | undefined;
        let afterRestart: Awaited<ReturnType<typeof enqueueForeground>> | undefined;
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              foregroundStarted.promise,
              foreground.settled,
              "Foreground work never entered the model",
            ),
            signal,
          );
          await first.start();
          const job = await first.add({
            name: "Pending reminder",
            enabled: false,
            deleteAfterRun: false,
            schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
            sessionTarget: "main",
            wakeMode,
            payload: { kind: "systemEvent", text: "Synthetic pending reminder" },
          });
          running = first.run(job.id, "force");
          await withinTest(
            awaitGateBeforeSettlement(queued.promise, running, "Cron event never queued"),
            signal,
          );
          expect(history(job.id)).toEqual([]);
          expect(peekSystemEventEntries(scope.sessionKey)).toMatchObject([
            { text: "Synthetic pending reminder" },
          ]);
          expect(prompts).toHaveLength(1);

          abortActiveCronTaskRuns();
          first.stop();
          releaseForeground.resolve();
          await withinTest(Promise.all([running, foreground.settled]), signal);
          await first.waitForIdle();
          await drainGlobalSingletonLifecycleState("restart");

          replacement = createService();
          await replacement.start();
          const interrupted = history(job.id);
          expect(interrupted).toMatchObject([
            { status: "error", error: expect.stringMatching(/restart/i) },
          ]);
          expect(interrupted).toHaveLength(1);
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
          replacement.stop();
          await replacement.waitForIdle();
          await replacement.start();
          expect(history(job.id)).toEqual(interrupted);

          // A later real turn cannot consume or replay the cancelled occurrence.
          afterRestart = await enqueueForeground("Synthetic work after restart", signal);
          await expect(withinTest(afterRestart.settled, signal)).resolves.toMatchObject({
            status: "completed",
          });
          expect(prompts).toHaveLength(2);
          expect(prompts.every((prompt) => !prompt.includes("Synthetic pending reminder"))).toBe(
            true,
          );
          expect(history(job.id)).toEqual(interrupted);
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
        } finally {
          abortActiveCronTaskRuns();
          releaseForeground.resolve();
          foreground.cancel();
          afterRestart?.cancel();
          first.stop();
          replacement?.stop();
          await Promise.allSettled([
            running,
            foreground.settled,
            afterRestart?.settled,
            first.waitForIdle(),
            replacement?.waitForIdle(),
          ]);
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);

it("finishes a queued Cron event only after its adopted turn and transport settle", async ({
  signal,
}) => {
  await withOpenClawTestState(
    { label: "cron-event-settlement", env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      const { createService, history } = await prepareCronSessionFixture(state);
      const registry = captureActivePluginRegistrySnapshot();
      const currentRegistry = expectDefined(registry.activeRegistry, "active plugin registry");
      const finished = createDeferred<CronEvent>();
      const finishedEvents: CronEvent[] = [];
      const cron = createService((event) => {
        if (event.action === "finished") {
          finishedEvents.push(event);
          finished.resolve(event);
        }
      });
      const started = createDeferred();
      const releaseModel = createDeferred();
      const sending = createDeferred();
      const releaseTransport = createDeferred();
      const route = { channel: "telegram", to: "-100001", accountId: "default" };
      const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(async () => {
        sending.resolve();
        await releaseTransport.promise;
        return { channel: "telegram", messageId: "queued-cron-report" };
      });
      const prompts: string[] = [];
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        prompts.push(params.prompt);
        await admitModelTurn(params);
        started.resolve();
        await releaseModel.promise;
        return { payloads: [{ text: "Synthetic report delivered" }], meta: { durationMs: 1 } };
      });
      try {
        const channels = createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              messaging: { normalizeTarget: (raw) => raw },
              outbound: { deliveryMode: "direct", sendText },
            } satisfies ChannelPlugin,
          },
        ]);
        setActivePluginRegistry({
          ...currentRegistry,
          channels: [
            ...currentRegistry.channels.filter((entry) => entry.plugin.id !== "telegram"),
            ...channels.channels,
          ],
          channelSetups: [
            ...currentRegistry.channelSetups.filter((entry) => entry.plugin.id !== "telegram"),
            ...channels.channelSetups,
          ],
        });
        await replaceSessionEntry(scope, {
          sessionId: "cron-restart-session",
          lifecycleRevision: "original",
          permissionMode: "full",
          delivery: normalizeSessionDeliveryState({ context: route }),
          updatedAt: Date.now(),
        });
        await cron.start();
        const job = await cron.add({
          name: "Adopted reminder",
          enabled: false,
          deleteAfterRun: false,
          schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Synthetic adopted reminder" },
        });
        await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
          ok: true,
          enqueued: true,
        });
        await withinTest(
          awaitGateBeforeSettlement(
            started.promise,
            finished.promise,
            "Cron turn never entered the model",
          ),
          signal,
        );
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("Synthetic adopted reminder");
        expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
        expect(history(job.id)).toEqual([]);
        expect(finishedEvents).toEqual([]);
        releaseModel.resolve();
        await withinTest(
          awaitGateBeforeSettlement(
            sending.promise,
            finished.promise,
            "Cron reply never reached transport",
          ),
          signal,
        );
        expect(sendText).toHaveBeenCalledOnce();
        expect(sendText.mock.calls[0]?.[0]).toMatchObject({
          to: route.to,
          text: "Synthetic report delivered",
        });
        expect(history(job.id)).toEqual([]);
        expect(finishedEvents).toEqual([]);
        releaseTransport.resolve();
        await expect(withinTest(finished.promise, signal)).resolves.toMatchObject({
          status: "ok",
          delivered: true,
        });
        await cron.waitForIdle();
        expect(history(job.id)).toMatchObject([{ status: "ok" }]);
        expect(history(job.id)).toHaveLength(1);
        cron.stop();
        await cron.waitForIdle();
        await drainGlobalSingletonLifecycleState("restart");
        await cron.start();
        expect(history(job.id)).toHaveLength(1);
        expect(prompts).toHaveLength(1);
        expect(sendText).toHaveBeenCalledOnce();
        expect(finishedEvents).toHaveLength(1);
        expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
      } finally {
        abortActiveCronTaskRuns();
        releaseModel.resolve();
        releaseTransport.resolve();
        cron.stop();
        await cron.waitForIdle();
        await drainGlobalSingletonLifecycleState("restart");
        resetSystemEventsForTest();
        restoreActivePluginRegistrySnapshot(registry);
      }
    },
  );
});
