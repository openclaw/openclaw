import { AsyncResource } from "node:async_hooks";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { withPluginServiceScheduler } from "../../plugins/service-scheduler-binding.js";
import { createPluginServiceScheduler } from "../../plugins/service-scheduler.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  assertAgentDatabaseAdmitted as assertAdmitted,
  readAgentDatabaseAdmissionRefusal as readRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import { enterAgentInputRecoveryContext } from "../../state/agent-input-recovery-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { OpenClawDatabaseSchemaPreflight as Preflight } from "../../state/openclaw-database-preflight.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { hasFinalChannelTurnDispatch } from "./dispatch-result.js";
import { runPreparedChannelTurn } from "./execution.js";
import {
  createCtx,
  createRecordInboundSession,
  expectDispatched,
} from "./run-channel-turn.delivery.test-helpers.js";
import { runChannelTurn } from "./run-channel-turn.js";
import type { PreparedChannelTurn, RunChannelTurnParams } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function createTurn(overrides: Partial<PreparedChannelTurn> = {}, observeOnly = false) {
  const onFinalize = vi.fn();
  const turn = {
    channel: "test",
    routeSessionKey: "agent:main:test:peer",
    storePath: overrides.storePath ?? path.join(tempDirs.make("channel-turn-"), "sessions.json"),
    ctxPayload: createCtx(),
    recordInboundSession: createRecordInboundSession(),
    runDispatch: vi.fn(async () => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    })),
    runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped: vi.fn() },
    ...overrides,
  } satisfies PreparedChannelTurn;
  const run = (turnAdoptionLifecycle?: RunChannelTurnParams<unknown>["turnAdoptionLifecycle"]) =>
    runChannelTurn({
      channel: "test",
      raw: {},
      turnAdoptionLifecycle,
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        preflight: () =>
          observeOnly ? { kind: "observeOnly", reason: "broadcast-observer" } : undefined,
        resolveTurn: () => turn,
        onFinalize,
      },
    });
  const expectIdle = () => {
    expect(turn.recordInboundSession).not.toHaveBeenCalled();
    expect(turn.runDispatch).not.toHaveBeenCalled();
  };
  return { turn, run, onFinalize, expectIdle };
}

it.each([true, false])("rejects unowned adoption (missing: %s)", async (missing) => {
  const { turn, run, onFinalize, expectIdle } = createTurn();
  if (missing) {
    Object.defineProperty(turn, "runDispatchLifecycle", { value: undefined });
  }
  await expect(run({ onAdopted: vi.fn(async () => undefined) })).rejects.toThrow(
    missing
      ? "prepared turns must declare runDispatchLifecycle"
      : "runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
  );
  expectIdle();
  expect(onFinalize.mock.calls[0]?.[0]).toMatchObject({
    admission: { kind: "dispatch" },
    dispatched: false,
  });
});

it.each(["record", "dispatch"])("checks authority before %s", async (boundary) => {
  const { turn, run } = createTurn();
  let current = boundary === "dispatch";
  const refusal = new Error("channel authority revoked");
  turn.assertAuthority = () => {
    if (!current) {
      throw refusal;
    }
  };
  turn.recordInboundSession = vi.fn(async () => {
    current = false;
  });

  await expect(run()).rejects.toBe(refusal);

  expect(turn.recordInboundSession).toHaveBeenCalledTimes(boundary === "record" ? 0 : 1);
  expect(turn.runDispatch).not.toHaveBeenCalled();
});

it("settles prepared resources when observe-only suppresses dispatch", async () => {
  const events: string[] = [];
  const onDispatchSkipped = vi.fn(async () => {
    events.push("cleanup");
  });
  const observed = { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  const { turn, run, onFinalize } = createTurn(
    {
      recordInboundSession: createRecordInboundSession(events),
      runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped },
      observeOnlyDispatchResult: observed,
    },
    true,
  );
  const result = await run();
  expectDispatched(result);
  expect(result.dispatchResult).toBe(observed);
  expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
  expect(events).toEqual(["record", "cleanup"]);
  expect(turn.runDispatch).not.toHaveBeenCalled();
  expect(onDispatchSkipped).toHaveBeenCalledWith("observeOnly");
  expect(hasFinalChannelTurnDispatch(result.dispatchResult)).toBe(false);
  expect(onFinalize).toHaveBeenCalledExactlyOnceWith(result);
});

it.each([
  { outcome: "recovered", crossAgent: false },
  { outcome: "failed", crossAgent: false },
  { outcome: "stopped", crossAgent: false },
  { outcome: "recovered", crossAgent: true },
] as const)(
  "holds fresh channel recording behind recovery: $outcome, cross-agent: $crossAgent",
  async ({ outcome, crossAgent }) => {
    const recovery = createDeferredCore();
    const waiting = createDeferredCore();
    const failure = new Error("Agent input recovery failed");
    const gateway = createTestGatewayScheduler(createGatewaySchedulerClock(0).clock);
    const { scheduler } = createPluginServiceScheduler(gateway);
    const preDispatchFailure = vi.fn();
    const pending = createTurn({
      ctxPayload: createCtx({
        AgentId: crossAgent ? "main" : "qa",
        SessionKey: crossAgent ? "agent:main:command:peer" : "agent:qa:channel:peer",
      }),
      ...(crossAgent ? { record: { sessionKey: "agent:qa:channel:peer" } } : {}),
      onPreDispatchFailure: preDispatchFailure,
    });
    const healthy = createTurn();
    const withRecovery = <T>(run: () => T) =>
      new AsyncResource("TestAgentInputRecovery").runInAsyncScope(() => {
        enterAgentInputRecoveryContext({
          resolveGatewayContext: () => ({
            inputRecovery: {
              isPending: (agentId) => agentId === "qa",
              waitForAgentInputRecovery: (agentId, options) => {
                if (agentId !== "qa") {
                  return undefined;
                }
                waiting.resolve();
                return racePromiseWithAbortSignal(recovery.promise, options?.signal);
              },
            },
          }),
        });
        return run();
      });
    const turn = withRecovery(() =>
      withPluginServiceScheduler(scheduler, () => runPreparedChannelTurn(pending.turn)),
    );
    void turn.catch(() => {});
    try {
      expect(
        await Promise.race([waiting.promise.then(() => "waiting"), turn.then(() => "dispatched")]),
      ).toBe("waiting");
      pending.expectIdle();
      expect((await withRecovery(() => healthy.run())).dispatched).toBe(true);
      if (outcome === "recovered") {
        recovery.resolve();
        expect((await turn).dispatched).toBe(true);
      } else {
        if (outcome === "failed") {
          recovery.reject(failure);
        } else {
          await scheduler.stop();
        }
        await expect(turn).rejects.toBeInstanceOf(Error);
        pending.expectIdle();
        expect(preDispatchFailure).toHaveBeenCalledOnce();
      }
    } finally {
      recovery.resolve();
      await Promise.allSettled([turn, scheduler.stop(), gateway.stop()]);
    }
  },
);

it.for(["admitted", "failed", "account-stopped", "gateway-stopped"] as const)(
  "keeps replay behind its agent startup admission: %s",
  async (outcome, { signal }) => {
    await withOpenClawTestState({ label: "channel-turn-startup-admission" }, async (state) => {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const { env } = state;
        const inspections = {
          qa: createDeferredCore<Preflight>(),
          other: createDeferredCore<Preflight>(),
        };
        const ready = { incompatible: [], indeterminate: [] };
        const finishInspections = () =>
          Object.values(inspections).forEach((item) => item.resolve(ready));
        const refusals = admission.defer({
          env,
          inspections: Object.entries(inspections).map(([agentId, inspection]) => ({
            target: { agentId, path: openOpenClawAgentDatabase({ agentId, env }).path },
            result: inspection.promise,
          })),
          reason: "Gateway startup is preparing the agent",
        });
        recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
        const lifetime = admission.adopt();
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: async () => {},
          migrateAgent: async () => {},
          publishAgent: async () => {},
        });
        const gateway = createTestGatewayScheduler(createGatewaySchedulerClock(0).clock);
        const { scheduler } = createPluginServiceScheduler(gateway);
        const preDispatchFailure = vi.fn();
        const log = vi.fn();
        const sessionKey = "agent:qa:qa-channel:direct:peer";
        const { turn: prepared, expectIdle } = createTurn({
          routeSessionKey: sessionKey,
          storePath: state.statePath("agents", "qa", "sessions", "sessions.json"),
          ctxPayload: createCtx({ AgentId: "qa", SessionKey: sessionKey }),
          recordInboundSession: vi.fn(async () => assertAdmitted("qa", { env })),
          onPreDispatchFailure: preDispatchFailure,
          log,
        });
        const { recordInboundSession: record, runDispatch: dispatch } = prepared;
        const turn = withPluginServiceScheduler(scheduler, () => runPreparedChannelTurn(prepared));
        void turn.catch(() => {});
        try {
          expectIdle();
          expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ reason: "agent-database-preparation-pending" }),
          );
          if (outcome === "admitted") {
            inspections.qa.resolve(ready);
            expect((await withinTest(turn, signal)).dispatched).toBe(true);
            expect(record).toHaveBeenCalledOnce();
            expect(dispatch).toHaveBeenCalledOnce();
            expect(readRefusal("other", { env })?.code).toBe("agent-database-inspection-pending");
          } else if (outcome === "failed") {
            inspections.qa.reject(new Error("inspection failed"));
            await expect(withinTest(turn, signal)).rejects.toThrow("inspection failed");
            expect(dispatch).not.toHaveBeenCalled();
            expect(preDispatchFailure).toHaveBeenCalledOnce();
          } else {
            const stopping = outcome === "account-stopped" ? scheduler.stop() : lifetime.stop();
            await expect(withinTest(turn, signal)).rejects.toBeInstanceOf(Error);
            expectIdle();
            expect(preDispatchFailure).toHaveBeenCalledOnce();
            finishInspections();
            await stopping;
          }
        } finally {
          finishInspections();
          await Promise.allSettled([turn, lifetime.stop(), scheduler.stop(), gateway.stop()]);
        }
      });
    });
  },
);
