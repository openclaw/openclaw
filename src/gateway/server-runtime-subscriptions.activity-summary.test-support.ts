import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as utilityCompletion from "../agents/utility-completion.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  replaceSessionEntrySync,
  persistSessionTranscriptTurn,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import { prewarmSessionHistoryWorker } from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import type { registerSessionPublicationTests } from "./server-runtime-subscriptions.publication.test-support.js";
import {
  activityRecapResult,
  preparedActivityRecapModel,
  seedRecapConversation,
} from "./session-activity-summaries.test-support.js";
import type { ActivitySummaryTarget } from "./session-activity-summary-state.js";
import * as observerModel from "./session-observer-model.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

type Start = (
  projection: SessionRowProjection,
  signal?: AbortSignal,
) => {
  params: Pick<
    Parameters<typeof startGatewayEventSubscriptions>[0],
    "broadcast" | "scheduler" | "sessionEventSubscribers"
  >;
  unsubs: { agentUnsub: () => Promise<void> };
};

export function registerActivitySummaryPublicationTests(
  start: Start,
  getOnChanged: () => ((target: ActivitySummaryTarget & { storePath: string }) => void) | undefined,
): void {
  it("delivers a coalesced recap after producer closure and joins it during shutdown", async () => {
    vi.useFakeTimers();
    const target = { key: "agent:main:recap", agentId: "main", storePath: "/recap/agent.sqlite" };
    const entry = { sessionId: "recap", lifecycleRevision: "original", updatedAt: 1 };
    const projection = createSessionRowProjectionFixture({
      cfg: { agents: { entries: { main: {} } } },
      store: { [target.key]: entry },
      storePath: target.storePath,
    });
    const producer = new AsyncWorkScope();
    const connectionWork = new GatewayConnectionWork();
    const { params, unsubs } = start(projection, connectionWork.signal);
    const entered = createDeferred();
    const release = createDeferred();
    const prepare = projection.withPreparedExactRows.bind(projection);
    vi.spyOn(projection, "withPreparedExactRows").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return prepare(...args);
    });
    let closing: Promise<void> | undefined;
    try {
      const onChanged = getOnChanged()!;
      producer.run(() => onChanged(target));
      projection.setEntry(target.key, { ...entry, label: "latest recap row" });
      producer.run(() => onChanged(target));
      await producer.drain();
      // server-lifecycle closes scheduler admission before connection work;
      // server-close then joins subscriptions before sockets and projection.
      params.scheduler.beginClose();
      connectionWork.beginClose();
      let closed = false;
      closing = unsubs.agentUnsub().then(() => {
        closed = true;
      });
      onChanged(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(false);
      expect(params.broadcast).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await entered.promise;
      release.resolve();
      await vi.runAllTimersAsync();
      await closing;
      expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
        "sessions.changed",
        expect.objectContaining({
          reason: "activity-summary",
          session: expect.objectContaining({
            key: target.key,
            sessionId: entry.sessionId,
            label: "latest recap row",
          }),
        }),
        expect.objectContaining({ sessionKeys: [target.key], agentId: target.agentId }),
      );
      onChanged(target);
      await vi.runAllTimersAsync();
      expect(params.broadcast).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await vi.runAllTimersAsync();
      await (closing ?? unsubs.agentUnsub());
      await params.scheduler.stop();
      await connectionWork.drain();
      projection.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("publishes a prepared recap while the real projection retains an unrelated dirty row", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const target = {
        key: "agent:main:recap",
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      for (const [key, sessionId] of [
        [target.key, "recap"],
        ["agent:main:unrelated", "unrelated"],
      ] as const) {
        replaceSessionEntrySync({ agentId: "main", sessionKey: key }, { sessionId, updatedAt: 1 });
      }
      const placements = createWorkerSessionPlacementStore();
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [],
        placementFactsReader: placements,
      }).catch((error: unknown) => {
        releaseForeground();
        throw error;
      });
      const entered = createDeferred();
      const release = createDeferred();
      let unsubs: ReturnType<Start>["unsubs"] | undefined;
      let sql: ReturnType<typeof observeHostDataSql> | undefined;
      try {
        const started = start(projection);
        const { params } = started;
        unsubs = started.unsubs;
        await projection.ensureMaterialized();
        const read = placements.readProjection.bind(placements);
        vi.spyOn(placements, "readProjection").mockImplementation(async (ids) => {
          const snapshot = await read(ids);
          if (ids.includes("unrelated")) {
            entered.resolve();
            await release.promise;
          }
          return snapshot;
        });
        sessionChanges.emit({ all: true, scope: "worker-placements" });
        await entered.promise;
        await withReadySessionRows(
          projection,
          () => [target],
          () => undefined,
        );
        expect(projection.needsMaterialization).toBe(true);
        const onChanged = getOnChanged();
        if (!onChanged) {
          throw new Error("missing activity-summary publication callback");
        }
        vi.useFakeTimers();
        sql = observeHostDataSql();
        onChanged(target);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({
            reason: "activity-summary",
            session: expect.objectContaining({ key: target.key, sessionId: "recap" }),
          }),
          {
            sessionKeys: [target.key],
            sessionEventSubscriptionKeys: [target.key],
            agentId: target.agentId,
            dropIfSlow: true,
            prepareSessionProjection: expect.any(Function),
          },
        );
        expect(projection.needsMaterialization).toBe(true);
        expect(sql.queries).toEqual([]);
      } finally {
        sql?.restore();
        vi.useRealTimers();
        release.resolve();
        try {
          await unsubs?.agentUnsub();
          await projection.ensureMaterialized();
        } finally {
          try {
            projection.dispose();
          } finally {
            releaseForeground();
          }
        }
      }
    });
  });
}

export function registerActivitySummaryRunTests(
  fixture: Parameters<typeof registerSessionPublicationTests>[0] & {
    runtimeConfigState: { value: OpenClawConfig };
  },
) {
  const { createParams, start, installHandlerFactory, runtimeConfigState } = fixture;
  it.each([true, false])(
    "recaps only completed runs when Gateway credentials are available=%s",
    async (available) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const target = { key: "agent:main:recap", agentId: "main" };
        const scope = {
          sessionKey: target.key,
          agentId: target.agentId,
          sessionId: "recap-session",
        };
        const cfg: OpenClawConfig = { agents: { defaults: { utilityModel: "test/utility" } } };
        runtimeConfigState.value = cfg;
        setRuntimeConfigSnapshot(cfg);
        using auth = vi.spyOn(utilityCompletion, "hasAvailableUtilityCompletionAuth");
        auth.mockResolvedValue(available);
        using prepare = vi.spyOn(observerModel, "defaultPrepareModel");
        prepare.mockResolvedValue(preparedActivityRecapModel);
        using complete = vi
          .spyOn(observerModel, "defaultCompleteModel")
          .mockResolvedValue(activityRecapResult("Completed the requested work."));
        await seedRecapConversation(scope, "Check the fix.");
        await prewarmSessionHistoryWorker({ agentId: "main", env: state.env });
        const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
        await projection.ensureMaterialized();
        installHandlerFactory(() =>
          Object.assign(vi.fn(), { retireTranscript: vi.fn(), dispose: vi.fn(async () => {}) }),
        );
        const clock = createGatewaySchedulerClock(Date.now());
        const unsubs = start({
          ...createParams(),
          scheduler: createTestGatewayScheduler(clock.clock),
          getSessionRowProjection: () => projection,
        });
        const settle = async <T>(run: () => T | Promise<T>) => {
          const work = new AsyncWorkScope();
          const result = await work.track(run);
          await work.drain();
          return result;
        };
        const lifecycle = (phase: string) =>
          emitAgentEvent({ runId: "recap-run", ...scope, stream: "lifecycle", data: { phase } });
        const operation = createReplyOperation({
          ...scope,
          target: captureSessionTarget({
            ...scope,
            storeScope: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
            incarnation: scope.sessionId,
          }),
          resetTriggered: false,
        });
        try {
          await settle(() => {
            lifecycle("start");
            emitSessionTranscriptUpdate({ target: scope });
          });
          expect(
            await settle(() =>
              unsubs.sessionActivitySummaries.ensure(target, loadSessionEntryReadOnly(scope)),
            ),
          ).toMatchObject({ state: "stale" });
          const startCalls = complete.mock.calls.length;
          await persistSessionTranscriptTurn(scope, {
            messages: [
              {
                eventId: "answer",
                parentId: `event-${scope.sessionKey}`,
                message: { role: "assistant", content: "Verified the fix." },
              },
            ],
            touchSessionEntry: false,
          });
          await settle(() => lifecycle("end"));
          expect({ startCalls, totalCalls: complete.mock.calls.length }).toEqual({
            startCalls: 0,
            totalCalls: available ? 1 : 0,
          });
          await clock.advanceBy(3_600_000);
          expect(auth).toHaveBeenCalledOnce();
          expect(complete).toHaveBeenCalledTimes(available ? 1 : 0);
        } finally {
          operation.complete();
          await unsubs.agentUnsub();
          projection.dispose();
        }
      });
    },
  );
}
