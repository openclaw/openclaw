import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getInProcessGatewayToolContext } from "../agents/tools/in-process-gateway.js";
import type { OpenClawConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { CronServiceState } from "../cron/service/state.js";
import { armTimer } from "../cron/service/timer.js";
import type { CronJobCreate } from "../cron/types.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type { buildGatewayCronService } from "./server-cron.js";

type CronFixture = ReturnType<typeof buildGatewayCronService>;
type CronJobOverrides = Partial<Omit<CronJobCreate, "name" | "payload">>;
type AddCronJob = (
  service: CronFixture,
  name: string,
  message: string,
  overrides?: CronJobOverrides,
) => ReturnType<CronFixture["cron"]["add"]>;
type GatewayCronContextTestHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  createCronService: (
    cfg: OpenClawConfig,
    overrides?: Pick<Parameters<typeof buildGatewayCronService>[0], "resolveGatewayContext">,
  ) => CronFixture;
  getCronState: (service: CronFixture) => CronServiceState;
  addAgentTurnJob: AddCronJob;
  addSystemEventJob: AddCronJob;
  loadConfigMock: { mockReturnValue: (cfg: OpenClawConfig) => unknown };
  runCronIsolatedAgentTurnMock: {
    mockImplementationOnce: (
      implementation: () => Promise<{ status: "ok"; summary: string }>,
    ) => unknown;
  };
  requestHeartbeatAndWaitMock: {
    mockImplementationOnce: (implementation: () => Promise<HeartbeatRunResult>) => unknown;
  };
};

export function registerGatewayCronContextTests({
  createCronConfig,
  createCronService,
  getCronState,
  addAgentTurnJob,
  addSystemEventJob,
  loadConfigMock,
  runCronIsolatedAgentTurnMock,
  requestHeartbeatAndWaitMock,
}: GatewayCronContextTestHarness) {
  const createBroker = useSpawnBrokerTestFixture(afterEach);
  it.each(["main", "agent:ops:cron:job-1:run:one"])(
    "keeps a targeted global wake on its selected agent's stored route (%s)",
    async (sessionKey) => {
      await withOpenClawTestState({ label: "cron-global-delivery-owner" }, async (state) => {
        const cfg = {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: { main: {}, ops: {} },
          },
          session: { scope: "global" },
          cron: { enabled: false, triggers: { enabled: false } },
        } satisfies OpenClawConfig;
        const routes = {
          main: { channel: "telegram", to: "telegram:main", accountId: "main", threadId: "11" },
          ops: { channel: "telegram", to: "telegram:ops", accountId: "ops", threadId: "22" },
        };
        loadConfigMock.mockReturnValue(cfg);
        for (const [agentId, context] of Object.entries(routes)) {
          await replaceSessionEntry(
            { agentId, sessionKey: "global", env: state.env },
            {
              sessionId: `${agentId}-global`,
              updatedAt: 1,
              delivery: normalizeSessionDeliveryState({ context }),
            },
          );
        }
        const service = createCronService(cfg);
        try {
          const enqueue = vi.spyOn(getCronState(service).deps, "enqueueSystemEvent");
          expect(
            service.cron.wake({
              mode: "next-heartbeat",
              text: "wake ops",
              agentId: "ops",
              sessionKey,
            }),
          ).toEqual({ ok: true });
          expect(enqueue).toHaveBeenCalledWith("wake ops", {
            agentId: "ops",
            sessionKey,
            deliveryContext: routes.ops,
          });
        } finally {
          await service.cron.stopAndDrain?.();
        }
      });
    },
  );

  it("owns timer execution and settlement after its creator context closes", async () => {
    const broker = await createBroker();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T01:00:00.000Z"));
    const cfg = createCronConfig("server-cron-scheduled-gateway-context");
    loadConfigMock.mockReturnValue(cfg);
    const gatewayContext = {
      terminalSessions: {},
      resolveGatewayContext: () => gatewayContext,
    } as never;
    const creatorContext = new AsyncLocalStorage<string>();
    const creatorWork = new AsyncWorkScope();
    let requestContextActive = true;
    const retiredRequestContext = {
      terminalSessions: { retired: true },
      resolveGatewayContext: () => (requestContextActive ? retiredRequestContext : undefined),
    } as never;
    const retiredRequestClient = { id: "retired-request" } as never;
    let observed: unknown = "never-ran";
    let observedClient: unknown = "never-ran";
    let observedCreator: unknown = "never-ran";
    let observedWork: unknown = "never-ran";
    let observedBroker: unknown = "never-ran";
    const settled = createDeferred();
    let settlementContext: unknown = "never-settled";
    let assertScheduledCaller: ReturnType<typeof captureGatewayToolCallerAssertion>;
    const ran = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      observedClient = getPluginRuntimeGatewayRequestScope()?.client;
      observedCreator = creatorContext.getStore();
      observedBroker = getSpawnBroker();
      observedWork = await trackAsyncWork(() => "completed").catch((error: unknown) => error);
      assertScheduledCaller = captureGatewayToolCallerAssertion();
      ran.resolve();
      return { status: "ok", text: "done" } as never;
    });

    const state = runWithSpawnBroker(broker, () =>
      createCronService(cfg, { resolveGatewayContext: () => gatewayContext }),
    );
    try {
      await state.cron.start();
      await addAgentTurnJob(state, "scheduled-isolated", "run it", {
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      });
      const cronState = getCronState(state);
      const onEvent = cronState.deps.onEvent;
      cronState.deps.onEvent = (event, context) => {
        onEvent?.(event, context);
        if (event.action === "finished") {
          settlementContext = getInProcessGatewayToolContext();
          settled.resolve();
        }
      };
      const creatorScope = await creatorWork.run(() =>
        creatorContext.run("expired creator", () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:schedule-creator",
              operationalRunInstance: { runId: "creator-run", instanceId: "creator-instance" },
              receiptAuthority: () => requestContextActive,
            },
            () =>
              withPluginRuntimeGatewayRequestScope(
                {
                  context: retiredRequestContext,
                  client: retiredRequestClient,
                  isWebchatConnect: () => false,
                } as never,
                () => {
                  armTimer(cronState);
                  return {
                    run: AsyncLocalStorage.snapshot(),
                    assertCurrent: captureGatewayToolCallerAssertion(),
                  };
                },
              ),
          ),
        ),
      );
      requestContextActive = false;
      await creatorWork.drain();

      // Fake timers need the context that a native timer captures when armed.
      await creatorScope.run(() => vi.advanceTimersByTimeAsync(60_000));
      await ran.promise;
      await settled.promise;

      expect(observedCreator).toBeUndefined();
      expect(observedWork).toBe("completed");
      expect(settlementContext).toBe(gatewayContext);
      expect(observed).toBe(gatewayContext);
      expect(observedClient).toBeUndefined();
      expect(observedBroker).toBe(broker);
      expect(() => assertScheduledCaller?.("chat.history")).not.toThrow();
      expect(() => creatorScope.assertCurrent?.("chat.history")).toThrow(
        "agent tool caller authority is no longer active",
      );
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("leaves a scheduler-triggered isolated run without context when no resolver is wired", async () => {
    const cfg = createCronConfig("server-cron-scheduled-gateway-context-absent");
    loadConfigMock.mockReturnValue(cfg);
    let observed: unknown = "never-ran";
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      return { status: "ok", text: "done" } as never;
    });

    const state = createCronService(cfg);
    try {
      const job = await addAgentTurnJob(state, "scheduled-isolated-no-resolver", "run it", {
        deleteAfterRun: false,
      });

      await state.cron.run(job.id, "force");

      expect(observed).toBeUndefined();
    } finally {
      state.cron.stop();
    }
  });

  it("withholds a retired gateway context from a scheduled run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T02:00:00.000Z"));
    // The process-wide context holder is not cleared on shutdown, so an
    // unfenced resolver would hand a queued run a retired context. No context
    // fails visibly; a retired one operates against a dead Gateway generation.
    const cfg = createCronConfig("server-cron-retired-gateway-context");
    loadConfigMock.mockReturnValue(cfg);
    const retiredContext = {
      terminalSessions: {},
      // Instance retired: its own lifecycle resolver reports unavailable.
      resolveGatewayContext: () => undefined,
    } as never;
    let observed: unknown = "never-ran";
    const ran = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      ran.resolve();
      return { status: "ok", text: "done" } as never;
    });

    const state = createCronService(cfg, { resolveGatewayContext: () => retiredContext });
    try {
      await state.cron.start();
      await addAgentTurnJob(state, "retired-context", "run it", {
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await ran.promise;

      expect(observed).toBeUndefined();
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("gives a scheduled heartbeat wake a resolvable gateway context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T03:00:00.000Z"));
    // Main-session cron jobs and heartbeat monitors reach the agent through the
    // heartbeat adapter, which shares the isolated path's contextless defect.
    const cfg = createCronConfig("server-cron-heartbeat-gateway-context");
    loadConfigMock.mockReturnValue(cfg);
    const gatewayContext = {
      terminalSessions: {},
      resolveGatewayContext: () => gatewayContext,
    } as never;
    let observed: unknown = "never-ran";
    const ran = createDeferred();
    requestHeartbeatAndWaitMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      ran.resolve();
      return { status: "ran", durationMs: 1 };
    });

    const state = createCronService(cfg, { resolveGatewayContext: () => gatewayContext });
    try {
      await state.cron.start();
      await addSystemEventJob(state, "scheduled-heartbeat", "run it", {
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await ran.promise;

      expect(observed).toBe(gatewayContext);
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("keeps an RPC-inherited gateway context instead of the scheduler resolver", async () => {
    const cfg = createCronConfig("server-cron-rpc-gateway-context");
    loadConfigMock.mockReturnValue(cfg);
    const rpcContext = { terminalSessions: { rpc: true } } as never;
    const schedulerContext = {
      terminalSessions: { scheduler: true },
      resolveGatewayContext: () => schedulerContext,
    } as never;
    const resolveGatewayContext = vi.fn(() => schedulerContext);
    let observed: unknown = "never-ran";
    let callerActive = true;
    let assertCaller: ReturnType<typeof captureGatewayToolCallerAssertion>;
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      assertCaller = captureGatewayToolCallerAssertion();
      return { status: "ok", text: "done" } as never;
    });

    const state = createCronService(cfg, { resolveGatewayContext });
    try {
      const job = await addAgentTurnJob(state, "rpc-isolated", "run it", {
        deleteAfterRun: false,
      });

      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:manual-run",
          operationalRunInstance: { runId: "manual-run", instanceId: "manual-instance" },
          receiptAuthority: () => callerActive,
        },
        () =>
          withPluginRuntimeGatewayRequestScope(
            { context: rpcContext, isWebchatConnect: () => false } as never,
            () => state.cron.run(job.id, "force"),
          ),
      );

      expect(observed).toBe(rpcContext);
      expect(assertCaller).toBeTypeOf("function");
      expect(() => assertCaller?.("chat.history")).not.toThrow();
      callerActive = false;
      expect(() => assertCaller?.("chat.history")).toThrow(
        "agent tool caller authority is no longer active",
      );
    } finally {
      state.cron.stop();
    }
  });
}
