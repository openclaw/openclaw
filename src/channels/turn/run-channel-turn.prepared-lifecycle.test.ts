import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { withPluginServiceScheduler } from "../../plugins/service-scheduler-binding.js";
import { createPluginServiceScheduler } from "../../plugins/service-scheduler.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.types.js";
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

type PreparedTurn = PreparedChannelTurn & {
  runDispatchLifecycle: NonNullable<PreparedChannelTurn["runDispatchLifecycle"]>;
};

describe("prepared channel turn lifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;
  beforeEach(() => {
    storePath = path.join(
      tempDirs.make("openclaw-channel-turn-prepared-lifecycle-"),
      "sessions.json",
    );
  });

  function createTurn(): PreparedTurn {
    return {
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      storePath,
      ctxPayload: createCtx(),
      recordInboundSession: createRecordInboundSession(),
      runDispatch: vi.fn(async () => ({
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      })),
      runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped: vi.fn() },
    };
  }
  function run(
    turn: PreparedTurn,
    options: {
      turnAdoptionLifecycle?: RunChannelTurnParams<unknown>["turnAdoptionLifecycle"];
      observeOnly?: boolean;
      onFinalize?: RunChannelTurnParams<unknown>["adapter"]["onFinalize"];
    } = {},
  ) {
    return runChannelTurn({
      channel: "test",
      raw: {},
      turnAdoptionLifecycle: options.turnAdoptionLifecycle,
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        preflight: () =>
          options.observeOnly ? { kind: "observeOnly", reason: "broadcast-observer" } : undefined,
        resolveTurn: () => turn,
        onFinalize: options.onFinalize,
      },
    });
  }

  it.each([
    { missing: true, message: "prepared turns must declare runDispatchLifecycle" },
    {
      missing: false,
      message: "runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
    },
  ])(
    "rejects unowned durable ingress adoption (missing lifecycle: $missing)",
    async ({ missing, message }) => {
      const turn = createTurn();
      if (missing) {
        Object.defineProperty(turn, "runDispatchLifecycle", { value: undefined });
      }
      const onFinalize = vi.fn();
      await expect(
        run(turn, {
          turnAdoptionLifecycle: { onAdopted: vi.fn(async () => undefined) },
          onFinalize,
        }),
      ).rejects.toThrow(message);
      expect(turn.recordInboundSession).not.toHaveBeenCalled();
      expect(turn.runDispatch).not.toHaveBeenCalled();
      expect(onFinalize).toHaveBeenCalledWith(
        expect.objectContaining({
          admission: { kind: "dispatch" },
          dispatched: false,
        }),
      );
    },
  );

  it.each(["record", "dispatch"])(
    "checks current channel authority before %s",
    async (boundary) => {
      const turn = createTurn();
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

      await expect(run(turn)).rejects.toBe(refusal);

      expect(turn.recordInboundSession).toHaveBeenCalledTimes(boundary === "record" ? 0 : 1);
      expect(turn.runDispatch).not.toHaveBeenCalled();
    },
  );

  it("settles prepared resources when observe-only suppresses dispatch", async () => {
    const events: string[] = [];
    const turn = createTurn();
    const onFinalize = vi.fn();
    let resourceOpen = true;
    const onDispatchSkipped = vi.fn(async () => {
      resourceOpen = false;
      events.push("cleanup");
    });
    turn.recordInboundSession = createRecordInboundSession(events);
    turn.runDispatchLifecycle = { turnAdoptionLifecycle: undefined, onDispatchSkipped };
    const observed = { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    turn.observeOnlyDispatchResult = observed;
    const result = await run(turn, { observeOnly: true, onFinalize });
    expectDispatched(result);
    expect(result.dispatchResult).toBe(observed);
    expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
    expect(events).toEqual(["record", "cleanup"]);
    expect(turn.runDispatch).not.toHaveBeenCalled();
    expect(onDispatchSkipped).toHaveBeenCalledWith("observeOnly");
    expect(resourceOpen).toBe(false);
    expect(hasFinalChannelTurnDispatch(result.dispatchResult)).toBe(false);
    expect(onFinalize).toHaveBeenCalledExactlyOnceWith(result);
  });
});

it.for(["admitted", "failed", "account-stopped", "gateway-stopped"] as const)(
  "keeps replay behind its agent startup admission: %s",
  async (outcome, { signal }) => {
    await withOpenClawTestState({ label: "channel-turn-startup-admission" }, async (state) => {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const inspections = new Map(
          ["qa", "other"].map((agentId) => [
            agentId,
            createDeferredCore<OpenClawDatabaseSchemaPreflight>(),
          ]),
        );
        const refusals = admission.defer({
          env: state.env,
          inspections: [...inspections].map(([agentId, inspection]) => ({
            target: {
              agentId,
              path: openOpenClawAgentDatabase({ agentId, env: state.env }).path,
            },
            result: inspection.promise,
          })),
          reason: "Gateway startup is preparing the agent",
        });
        recordAgentDatabaseAdmissions(refusals, { env: state.env, source: "startup" });
        const lifetime = admission.adopt();
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: async () => {},
          migrateAgent: async () => {},
          publishAgent: async () => {},
        });
        const clock = createGatewaySchedulerClock(0);
        const gateway = createTestGatewayScheduler(clock.clock);
        const { scheduler } = createPluginServiceScheduler(gateway);
        const record = vi.fn(async () => assertAgentDatabaseAdmitted("qa", { env: state.env }));
        const dispatch = vi.fn(async () => ({
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        }));
        const preDispatchFailure = vi.fn();
        const sessionKey = "agent:qa:qa-channel:direct:peer";
        const turn = withPluginServiceScheduler(scheduler, () =>
          runPreparedChannelTurn({
            channel: "qa-channel",
            routeSessionKey: sessionKey,
            storePath: state.statePath("agents", "qa", "sessions", "sessions.json"),
            ctxPayload: finalizeInboundContext({
              AgentId: "qa",
              SessionKey: sessionKey,
              Body: "replayed inbound",
              Provider: "qa-channel",
            }),
            recordInboundSession: record,
            runDispatch: dispatch,
            onPreDispatchFailure: preDispatchFailure,
          }),
        );
        void turn.catch(() => {});
        try {
          expect(record).not.toHaveBeenCalled();
          expect(dispatch).not.toHaveBeenCalled();
          if (outcome === "admitted") {
            inspections.get("qa")!.resolve({ incompatible: [], indeterminate: [] });
            expect((await withinTest(turn, signal)).dispatched).toBe(true);
            expect(record).toHaveBeenCalledOnce();
            expect(dispatch).toHaveBeenCalledOnce();
            expect(readAgentDatabaseAdmissionRefusal("other", { env: state.env })?.code).toBe(
              "agent-database-inspection-pending",
            );
          } else if (outcome === "failed") {
            inspections.get("qa")!.reject(new Error("inspection failed"));
            await expect(withinTest(turn, signal)).rejects.toThrow("inspection failed");
            expect(dispatch).not.toHaveBeenCalled();
            expect(preDispatchFailure).toHaveBeenCalledOnce();
          } else {
            const stopping = outcome === "account-stopped" ? scheduler.stop() : lifetime.stop();
            await expect(withinTest(turn, signal)).rejects.toBeInstanceOf(Error);
            expect(record).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
            expect(preDispatchFailure).toHaveBeenCalledOnce();
            for (const inspection of inspections.values()) {
              inspection.resolve({ incompatible: [], indeterminate: [] });
            }
            await stopping;
          }
        } finally {
          for (const inspection of inspections.values()) {
            inspection.resolve({ incompatible: [], indeterminate: [] });
          }
          await Promise.allSettled([turn, lifetime.stop(), scheduler.stop(), gateway.stop()]);
        }
      });
    });
  },
);
