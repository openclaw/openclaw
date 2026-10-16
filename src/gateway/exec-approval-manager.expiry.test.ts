import { copyFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { reserveSqliteWorkerInputPreparation } from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  createTestApprovalFixture,
  createTestApprovalManager,
  createApprovalScheduler,
  createPreparedTestApprovalManager,
} from "./exec-approval-manager.test-support.js";
import * as operatorApprovalStore from "./operator-approval-store.js";

const resolver = { kind: "system", id: "fixture" } as const;

describe("ExecApprovalManager timeout expiry publication", () => {
  let scheduled: ReturnType<typeof createApprovalScheduler>;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    scheduled = createApprovalScheduler();
  });

  afterEach(async () => {
    await scheduled.scheduler.stop();
    vi.restoreAllMocks();
  });

  function holdWorkerInputCapacity() {
    const reservations: ReturnType<typeof reserveSqliteWorkerInputPreparation>[] = [];
    const release = () => {
      for (const reservation of reservations.splice(0)) {
        reservation.release();
      }
    };
    try {
      for (let index = 0; index < 4; index += 1) {
        reservations.push(reserveSqliteWorkerInputPreparation(64 * 1024 * 1024));
      }
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  it("rejects approval records when expiry would exceed the Date range", (testContext) => {
    const manager = createTestApprovalManager(testContext);
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    expect(() => manager.create({ command: "echo ok" }, 1, "approval-overflow")).toThrow(
      "approval expiry is unavailable",
    );
  });

  it.for(["cancellation", "storage repair"] as const)(
    "lets the deadline win when %s waits for transaction admission",
    async (operation, test) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const { manager } = createTestApprovalFixture(test, { scheduler: scheduled.scheduler });
      const record = manager.create({ command: "echo queued" }, 1_000, "queued-expiry");
      const { decision } = await manager.register(record, 1_000);
      if (operation === "storage repair") {
        const failedResolve = vi
          .spyOn(operatorApprovalStore, "resolveOperatorApproval")
          .mockRejectedValueOnce(new Error("synthetic storage failure"));
        await expect(manager.resolve(record.id, "allow-once")).rejects.toThrow(
          "synthetic storage failure",
        );
        failedResolve.mockRestore();
      }

      const entered = createDeferredCore();
      const admitted = createDeferredCore<number>();
      const forceDeny = operatorApprovalStore.forceDenyOperatorApproval;
      vi.spyOn(operatorApprovalStore, "forceDenyOperatorApproval").mockImplementation(
        async (params) => {
          entered.resolve();
          const admittedNowMs = await admitted.promise;
          return forceDeny({ ...params, nowMs: params.nowMs ?? admittedNowMs });
        },
      );
      const transition =
        operation === "cancellation"
          ? manager.forceDenyDetailed(record.id, "run-aborted", resolver, "cancelled")
          : manager.resolveDetailed(record.id, "deny", resolver);
      try {
        await entered.promise;
        clock.mockReturnValue(record.expiresAtMs);
        admitted.resolve(record.expiresAtMs);
        await expect(transition).resolves.toMatchObject({
          outcome: "expired",
          record: {
            status: "expired",
            terminalReason: "timeout",
            resolvedAtMs: record.expiresAtMs,
          },
        });
        await expect(decision).resolves.toBe(operation === "cancellation" ? null : "deny");
      } finally {
        admitted.resolve(record.expiresAtMs);
        await transition.catch(() => undefined);
        await manager.drain();
      }
    },
  );

  async function replaceDatabase(databasePath: string) {
    const original = await stat(databasePath);
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    const replacement = `${databasePath}.replacement`;
    await copyFile(databasePath, replacement);
    await rename(replacement, databasePath);
    expect((await stat(databasePath)).ino).not.toBe(original.ino);
  }

  async function prepareExpiry(testContext: TestContext) {
    const refused = createDeferredCore<unknown>();
    const onExpired = vi.fn();
    const onLifecycle = vi.fn();
    const onError = vi.fn((error: unknown) => refused.resolve(error));
    const { manager, databaseOptions } = await createPreparedTestApprovalManager(testContext, {
      scheduler: scheduled.scheduler,
      onExpired,
      onLifecycle,
      onError,
    });
    const timers = scheduled.wakes;
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const record = manager.create({ command: "echo expiry" }, 1_000, "expiry-backpressure");
    const { decision } = await manager.register(record, 1_000);
    const handoff = vi.fn(async () => {});
    const { observation } = manager.registerDecisionHandoff(record.id, handoff);
    const decisionSettled = vi.fn();
    void decision.then(decisionSettled, () => undefined);
    void observation.catch(() => undefined);
    // Completion can re-arm a pending deadline; only its latest host wake is live.
    const deadlines = () => [
      ...new Map(
        timers.filter(({ delayMs }) => delayMs !== 15_000).map((wake) => [wake.atMs, wake]),
      ).values(),
    ];
    const invoke = async (timer: (typeof timers)[number] | undefined) => {
      await expectDefined(timer, "approval timer").run();
    };
    const read = (options = databaseOptions) =>
      operatorApprovalStore.getOperatorApprovalDetailed({
        id: record.id,
        databaseOptions: options,
        nowMs: record.createdAtMs,
      });
    return {
      expire: async () => {
        clock.mockReturnValue(record.expiresAtMs);
        await invoke(deadlines()[0]);
      },
      refuseNext: () =>
        vi
          .mocked(operatorApprovalStore.forceDenyOperatorApproval)
          .mockRejectedValueOnce(
            new SqliteWorkerError("synthetic pre-execution unavailable", "unavailable"),
          ),
      expectStored: async (expected: object, options = databaseOptions) => {
        expect(await read(options)).toMatchObject({ outcome: "found", record: expected });
      },
      read,
      terminalEvents: () => onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal"),
      expectUnsettled: () => {
        expect(decisionSettled).not.toHaveBeenCalled();
        expect(onExpired).not.toHaveBeenCalled();
        expect(handoff).not.toHaveBeenCalled();
      },
      manager,
      databaseOptions,
      record,
      clock,
      deadlines,
      invoke,
      refused,
      onError,
      decision,
      decisionSettled,
      handoff,
      observation,
      onExpired,
    };
  }

  it.for(["overloaded", "unavailable"] as const)(
    "expires the original waiter after %s admission recovers without a client read",
    async (code, testContext) => {
      const fixture = await prepareExpiry(testContext);
      const { record, deadlines } = fixture;
      expect(deadlines()).toHaveLength(1);
      const releaseCapacity = code !== "unavailable" ? holdWorkerInputCapacity() : undefined;
      if (code === "unavailable") {
        fixture.refuseNext();
      }
      try {
        await fixture.expire();
        await expect(
          Promise.race([fixture.refused.promise, fixture.decision]),
        ).resolves.toBeInstanceOf(Error);
        expect(fixture.onError.mock.calls[0]?.[0]).toMatchObject({ code });
        fixture.expectUnsettled();
        expect(fixture.terminalEvents()).toHaveLength(0);
      } finally {
        releaseCapacity?.();
      }
      expect(deadlines()).toHaveLength(2);
      const retry = deadlines()[1];
      expect(retry?.delayMs).toBeGreaterThan(0);
      fixture.clock.mockReturnValue(record.expiresAtMs + (retry?.delayMs ?? 0));
      const retryFailure = createDeferredCore<unknown>();
      fixture.onError.mockImplementationOnce((error) => retryFailure.resolve(error));
      await fixture.invoke(retry);
      await expect(Promise.race([fixture.decision, retryFailure.promise])).resolves.toBeNull();
      await fixture.observation;
      expect(fixture.handoff).toHaveBeenCalledExactlyOnceWith(null);
      expect(fixture.onExpired).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: record.id, status: "expired" }),
        expect.objectContaining({ request: { command: "echo expiry" } }),
      );
      expect(fixture.terminalEvents()).toHaveLength(1);
      await fixture.expectStored({
        status: "expired",
        expiresAtMs: 2_000,
        terminalReason: "timeout",
      });
    },
  );

  it.for(["retire", "replace"] as const)(
    "does not adopt a new expiry owner after %s",
    async (action, testContext) => {
      const fixture = await prepareExpiry(testContext);
      const { manager, databaseOptions, record, clock, deadlines, invoke, refused, onError } =
        fixture;
      fixture.refuseNext();
      await fixture.expire();
      await refused.promise;
      expect(deadlines()).toHaveLength(2);
      if (action === "retire") {
        await manager.drain();
        expect(deadlines()[1]?.cancelled).toBe(true);
        await invoke(deadlines()[1]);
      } else {
        await replaceDatabase(databaseOptions.path);
        const retryRefused = createDeferredCore<unknown>();
        onError.mockImplementationOnce((error) => retryRefused.resolve(error));
        clock.mockReturnValue(record.expiresAtMs + (deadlines()[1]?.delayMs ?? 0));
        await invoke(deadlines()[1]);
        await expect(retryRefused.promise).resolves.toBeInstanceOf(Error);
      }
      fixture.expectUnsettled();
      expect(record.resolvedAtMs).toBeUndefined();
      expect(deadlines()).toHaveLength(2);
      await fixture.expectStored({ status: "pending", expiresAtMs: 2_000 });
    },
  );

  it.for([
    { operation: "resolve", replaced: true },
    { operation: "cancel", replaced: false },
    { operation: "cancel", replaced: true },
    { operation: "reconcile", replaced: false },
    { operation: "reconcile", replaced: true },
  ] as const)(
    "retains expiry custody for $operation (replacement: $replaced)",
    async ({ operation, replaced }, testContext) => {
      const fixture = await prepareExpiry(testContext);
      const { manager, databaseOptions, record, clock, deadlines, refused } = fixture;
      const releaseCapacity = holdWorkerInputCapacity();
      try {
        await fixture.expire();
        await expect(Promise.race([refused.promise, fixture.decision])).resolves.toBeInstanceOf(
          Error,
        );
      } finally {
        releaseCapacity();
      }
      expect(deadlines()).toHaveLength(2);
      if (replaced) {
        await replaceDatabase(databaseOptions.path);
      }
      // A wall-clock rollback leaves a legitimate same-owner verdict possible.
      clock.mockReturnValue(record.createdAtMs + 500);
      let observed: operatorApprovalStore.OperatorApprovalRecord | undefined;
      if (operation === "reconcile") {
        const committed = await operatorApprovalStore.resolveOperatorApproval({
          id: record.id,
          decision: "allow-once",
          resolver: { kind: "device", id: "fixture" },
          expectedKind: "exec",
          runtimeEpoch: manager.runtimeEpoch,
          databaseOptions,
          nowMs: Date.now(),
        });
        expect(committed.outcome).toBe("resolved");
        if (!("record" in committed)) {
          throw new Error("expected durable winner");
        }
        observed = committed.record;
      }
      const transition =
        operation === "reconcile"
          ? manager.reconcileDurableLookup({
              outcome: "found",
              record: expectDefined(observed, "observed terminal"),
            })
          : operation === "resolve"
            ? manager.resolve(record.id, "allow-once")
            : manager.forceDenyDetailed(record.id, "run-aborted", resolver, "cancelled");
      const outcome = await transition.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      const stored = await fixture.read();
      if (replaced) {
        expect({
          accepted: outcome.ok,
          settled: fixture.decisionSettled.mock.calls.length,
          stored,
        }).toMatchObject({
          accepted: false,
          settled: 0,
          stored: {
            outcome: "found",
            record: { status: operation === "reconcile" ? "allowed" : "pending" },
          },
        });
        expect(record.resolvedAtMs).toBeUndefined();
        expect(fixture.handoff).not.toHaveBeenCalled();
        expect(fixture.terminalEvents()).toHaveLength(0);
      } else {
        expect(outcome.ok).toBe(true);
        const expectedDecision = operation === "cancel" ? null : "allow-once";
        await expect(fixture.decision).resolves.toBe(expectedDecision);
        await fixture.observation;
        expect(fixture.handoff).toHaveBeenCalledExactlyOnceWith(expectedDecision);
        expect(fixture.terminalEvents()).toHaveLength(1);
        expect(deadlines()[1]?.cancelled).toBe(true);
        if (operation === "cancel") {
          expect(outcome).toMatchObject({ value: { outcome: "denied" } });
          expect(await manager.getSnapshot(record.id)).toMatchObject({
            status: "cancelled",
            terminalReason: "run-aborted",
          });
          expect(manager.consumeAskFallback(record.id)).toBe(false);
        }
      }
      if (operation === "cancel") {
        expect(record.approvalAuthority?.()).toBe(false);
      }
    },
  );

  it.for(["resolve", "deny"] as const)(
    "keeps the original expiry target when %s follows an ambient reroute",
    async (operation, testContext) => {
      const fixture = await prepareExpiry(testContext);
      const { manager, databaseOptions, record, clock, refused } = fixture;
      const originalPath = databaseOptions.path;
      const redirected = {
        ...databaseOptions,
        path: path.join(path.dirname(originalPath), "redirected.sqlite"),
      };
      const original = await fixture.read();
      if (original.outcome !== "found") {
        throw new Error("expected original pending row");
      }
      try {
        await operatorApprovalStore.insertOperatorApproval({
          approval: original.record,
          databaseOptions: redirected,
        });
        fixture.refuseNext();
        await fixture.expire();
        await refused.promise;
        clock.mockReturnValue(record.createdAtMs + 500);
        databaseOptions.path = redirected.path;
        if (operation === "resolve") {
          await manager.resolve(record.id, "allow-once");
        } else {
          await manager.forceDenyDetailed(record.id, "malformed-verdict", resolver);
        }
        databaseOptions.path = originalPath;
        await fixture.expectStored({ status: operation === "resolve" ? "allowed" : "denied" });
        await fixture.expectStored({ status: "pending" }, redirected);
        await expect(fixture.decision).resolves.toBe(
          operation === "resolve" ? "allow-once" : "deny",
        );
        await fixture.observation;
        expect(fixture.handoff).toHaveBeenCalledTimes(1);
      } finally {
        databaseOptions.path = originalPath;
        await closeOpenClawStateDatabaseByPathAsync(redirected.path);
      }
    },
  );

  it.for(["closed", "cleanup-aggregate", "outcome-unknown", "recovered-outcome"] as const)(
    "does not replay an autonomous expiry after %s",
    async (failure, testContext) => {
      const fixture = await prepareExpiry(testContext);
      const { deadlines, refused } = fixture;
      const forceDeny = operatorApprovalStore.forceDenyOperatorApproval;
      const realDeny = expectDefined(
        vi.mocked(forceDeny).getMockImplementation(),
        "clock-bound expiry writer",
      );
      const spy = vi.mocked(forceDeny).mockImplementationOnce(async (params) => {
        if (failure === "outcome-unknown" || failure === "recovered-outcome") {
          await realDeny(params);
          throw new SqliteWorkerError("synthetic lost expiry result", "outcome-unknown");
        }
        if (failure === "cleanup-aggregate") {
          throw new AggregateError(
            [
              new SqliteWorkerError("synthetic refused expiry", "unavailable"),
              new Error("synthetic cleanup failure"),
            ],
            "unsettled expiry cleanup",
          );
        }
        throw new SqliteWorkerError("synthetic closed worker", "closed");
      });
      if (failure === "outcome-unknown") {
        vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockRejectedValueOnce(
          new SqliteWorkerError("synthetic readback unavailable", "unavailable"),
        );
      }
      await fixture.expire();
      await expect(refused.promise).resolves.toBeInstanceOf(Error);
      expect(deadlines()).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
      if (failure === "recovered-outcome") {
        await expect(fixture.decision).resolves.toBeNull();
        await fixture.observation;
        expect(fixture.onExpired).toHaveBeenCalledTimes(1);
        expect(fixture.handoff).toHaveBeenCalledExactlyOnceWith(null);
      } else {
        fixture.expectUnsettled();
      }
      await fixture.expectStored({
        status:
          failure === "outcome-unknown" || failure === "recovered-outcome" ? "expired" : "pending",
      });
    },
  );
});
