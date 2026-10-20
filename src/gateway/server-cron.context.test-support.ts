import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getInProcessGatewayToolContext } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { refreshCronScheduler } from "../cron/service/scheduler-actor.js";
import type { CronServiceState } from "../cron/service/state.js";
import type { CronJobCreate } from "../cron/types.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type { buildGatewayCronService } from "./server-cron.js";

export type CronFixture = ReturnType<typeof buildGatewayCronService>;
type CronJobOverrides = Partial<Omit<CronJobCreate, "name" | "payload">>;
export type AddCronJob = (
  service: CronFixture,
  name: string,
  message: string,
  overrides?: CronJobOverrides,
) => ReturnType<CronFixture["cron"]["add"]>;
type GatewayCronContextTestHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  createCronService: (
    cfg: OpenClawConfig,
    overrides?: Partial<
      Pick<Parameters<typeof buildGatewayCronService>[0], "resolveGatewayContext" | "scheduler">
    >,
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
  function config(name: string) {
    const cfg = createCronConfig(name);
    loadConfigMock.mockReturnValue(cfg);
    return cfg;
  }
  function timedConfig(name: string, hour: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`2026-08-21T${hour}:00:00.000Z`));
    return { cfg: config(name), clock: createGatewaySchedulerClock(Date.now()) };
  }
  const scheduledJob = (): CronJobOverrides => ({
    deleteAfterRun: false,
    schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
  });
  const gatewayContext = () => {
    const context = { terminalSessions: {}, resolveGatewayContext: () => context } as never;
    return context;
  };
  function ownedService(...args: Parameters<typeof createCronService>) {
    const state = createCronService(...args);
    return Object.assign(state, {
      [Symbol.dispose]() {
        state.cron.stop();
        vi.useRealTimers();
      },
    });
  }
  function callerFixture(
    name: string,
    scope: Parameters<typeof withPluginRuntimeGatewayRequestScope>[0],
  ) {
    const caller = {
      active: true,
      assertCurrent: captureGatewayToolCallerAssertion(),
      run<T>(run: () => T) {
        return withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: `agent:main:${name}`,
            operationalRunInstance: { runId: name, instanceId: `${name}-instance` },
            receiptAuthority: () => caller.active,
          },
          () => {
            caller.assertCurrent = captureGatewayToolCallerAssertion();
            return withPluginRuntimeGatewayRequestScope(scope, run);
          },
        );
      },
    };
    return caller;
  }
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
        setRuntimeConfigSnapshot(cfg);
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
            await service.cron.wake({
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

  it.each(["update", "updateWithPrecondition"] as const)(
    "forwards authority options through the %s lifecycle wrapper",
    async (method) => {
      const cfg = createCronConfig(`server-cron-update-authority-${method}`);
      loadConfigMock.mockReturnValue(cfg);
      const state = createCronService(cfg);
      const owner = {
        agentId: "main",
        sessionKey: "agent:main:discord:group:ops",
        accountId: "work",
      };
      const scheduledToolPolicy = {
        version: 1 as const,
        mode: "account" as const,
        ownerSessionKey: owner.sessionKey,
        ownerAccountId: owner.accountId,
      };
      let restarted: CronFixture | undefined;

      try {
        const job = await addSystemEventJob(state, `authority ${method}`, "run", {
          owner,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "now",
        });
        let current = true;
        const commitGuard = () => {
          if (!current) {
            throw new Error("cron mutation authority was revoked");
          }
        };
        const patch = {
          sessionTarget: "isolated" as const,
          payload: { kind: "agentTurn" as const, message: "updated", toolsAllow: ["write"] },
        };
        const options = { scheduledToolPolicy, commitGuard };

        const update = (candidate: Parameters<CronFixture["cron"]["update"]>[1]) =>
          method === "update"
            ? state.cron.update(job.id, candidate, options)
            : state.cron.updateWithPrecondition(job.id, candidate, () => undefined, options);
        await update(patch);

        current = false;
        await expect(
          update({ ...patch, payload: { ...patch.payload, message: "unauthorized change" } }),
        ).rejects.toThrow("cron mutation authority was revoked");

        state.cron.stop();
        restarted = createCronService(cfg);
        const persisted = await restarted.cron.readJob(job.id);
        expect(persisted?.scheduledToolPolicy).toEqual(scheduledToolPolicy);
        expect(persisted?.payload).toMatchObject(patch.payload);
      } finally {
        state.cron.stop();
        restarted?.cron.stop();
      }
    },
  );

  it("owns timer execution and settlement after its creator context closes", async () => {
    const broker = await createBroker();
    const { cfg, clock } = timedConfig("server-cron-scheduled-gateway-context", "01");
    const context = gatewayContext();
    const creatorContext = new AsyncLocalStorage<string>();
    const creatorWork = new AsyncWorkScope();
    const retiredRequestContext = {
      terminalSessions: { retired: true },
      resolveGatewayContext: () => (caller.active ? retiredRequestContext : undefined),
    } as never;
    const retiredRequestClient = { id: "retired-request" } as never;
    const caller = callerFixture("schedule-creator", {
      context: retiredRequestContext,
      client: retiredRequestClient,
      isWebchatConnect: () => false,
    } as never);
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

    using state = runWithSpawnBroker(broker, () =>
      ownedService(cfg, {
        scheduler: createTestGatewayScheduler(clock.clock),
        resolveGatewayContext: () => context,
      }),
    );
    await state.cron.start();
    await addAgentTurnJob(state, "scheduled-isolated", "run it", scheduledJob());
    const cronState = getCronState(state);
    const onEvent = cronState.deps.onEvent;
    cronState.deps.onEvent = (event, eventContext) => {
      onEvent?.(event, eventContext);
      if (event.action === "finished") {
        settlementContext = getInProcessGatewayToolContext();
        settled.resolve();
      }
    };
    const creatorScope = await creatorWork.run(() =>
      creatorContext.run("expired creator", () =>
        caller.run(() => {
          refreshCronScheduler(cronState);
          return AsyncLocalStorage.snapshot();
        }),
      ),
    );
    caller.active = false;
    await creatorWork.drain();
    await creatorScope(() => clock.advanceBy(60_000));
    await ran.promise;
    await settled.promise;
    expect({ observedCreator, observedWork, observedClient }).toEqual({
      observedCreator: undefined,
      observedWork: "completed",
      observedClient: undefined,
    });
    expect(settlementContext).toBe(context);
    expect(observed).toBe(context);
    expect(observedBroker).toBe(broker);
    expect(() => assertScheduledCaller?.("chat.history")).not.toThrow();
    expect(() => caller.assertCurrent?.("chat.history")).toThrow(
      "agent tool caller authority is no longer active",
    );
  });

  it.each(["absent", "retired", "heartbeat"] as const)(
    "exposes only a live scheduler-owned context (%s)",
    async (mode) => {
      const name = `server-cron-gateway-context-${mode}`;
      const { cfg, clock } =
        mode === "absent" ? { cfg: config(name), clock: undefined } : timedConfig(name, "02");
      const context =
        mode === "retired"
          ? ({ terminalSessions: {}, resolveGatewayContext: () => undefined } as never)
          : gatewayContext();
      const ran = createDeferred();
      let observed: unknown = "never-ran";
      const observe = () => {
        observed = getInProcessGatewayToolContext();
        ran.resolve();
      };
      if (mode === "heartbeat") {
        requestHeartbeatAndWaitMock.mockImplementationOnce(async () => {
          observe();
          return { status: "ran", durationMs: 1 };
        });
      } else {
        runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
          observe();
          return { status: "ok", text: "done" } as never;
        });
      }
      using state = ownedService(
        cfg,
        clock
          ? {
              scheduler: createTestGatewayScheduler(clock.clock),
              resolveGatewayContext: () => context,
            }
          : undefined,
      );
      if (clock) {
        await state.cron.start();
      }
      const addJob = mode === "heartbeat" ? addSystemEventJob : addAgentTurnJob;
      const job = await addJob(state, name, "run it", {
        ...(clock ? scheduledJob() : { deleteAfterRun: false }),
        ...(mode === "heartbeat" ? { sessionTarget: "main", wakeMode: "now" } : {}),
      });
      if (clock) {
        await clock.advanceBy(60_000);
      } else {
        await state.cron.run(job.id, "force");
      }
      await ran.promise;
      expect(observed).toBe(mode === "heartbeat" ? context : undefined);
    },
  );

  it("replaces an RPC-inherited gateway context with the scheduler owner after activation", async () => {
    const cfg = config("server-cron-rpc-gateway-context");
    const rpcContext = { terminalSessions: { rpc: true } } as never;
    const schedulerContext = gatewayContext();
    const resolveGatewayContext = vi.fn(() => schedulerContext);
    let observed: unknown = "never-ran";
    let assertCaller: ReturnType<typeof captureGatewayToolCallerAssertion>;
    const caller = callerFixture("manual-run", {
      context: rpcContext,
      isWebchatConnect: () => false,
    } as never);
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      assertCaller = captureGatewayToolCallerAssertion();
      return { status: "ok", text: "done" } as never;
    });

    using state = ownedService(cfg, { resolveGatewayContext });
    const job = await addAgentTurnJob(state, "rpc-isolated", "run it", {
      deleteAfterRun: false,
    });

    await caller.run(() => state.cron.run(job.id, "force"));

    expect(observed).toBe(schedulerContext);
    expect(assertCaller).toBeUndefined();
    expect(caller.assertCurrent).toBeTypeOf("function");
    expect(() => caller.assertCurrent?.("chat.history")).not.toThrow();
    caller.active = false;
    expect(() => caller.assertCurrent?.("chat.history")).toThrow(
      "agent tool caller authority is no longer active",
    );
  });
}
