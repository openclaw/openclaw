// Focused coverage for timer-driven approval expiry publication; the main
// exec-approval-manager suite sits at the max-lines cap.
import fs from "node:fs";
import { copyFile, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { SQLITE_WORKER_MAX_QUEUED_BYTES } from "../infra/sqlite-worker-broker.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { reserveSqliteWorkerInputPreparation } from "../infra/sqlite-worker-store.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import {
  createTestApprovalManager,
  createPreparedTestApprovalManager,
  installTestApprovalClock,
} from "./exec-approval-manager.test-support.js";
import * as operatorApprovalStore from "./operator-approval-store.js";

type TimeoutCallback = Parameters<typeof setTimeout>[0];
type MockTimerHandle = ReturnType<typeof setTimeout> & {
  unref: ReturnType<typeof vi.fn>;
};

describe("ExecApprovalManager timeout expiry publication", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await closeOpenClawStateDatabaseByPathAsync(path.join(dir, "s.sqlite"));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function installTimerMocks() {
    const timers: Array<{
      callback: TimeoutCallback;
      delay: number | undefined;
      handle: MockTimerHandle;
    }> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimeoutCallback,
      delay?: number,
    ) => {
      const handle = {
        unref: vi.fn(),
        refresh: vi.fn().mockReturnThis(),
      } as unknown as MockTimerHandle;
      timers.push({ callback, delay, handle });
      return handle;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => undefined) as typeof clearTimeout,
    );
    return timers;
  }

  it("rejects approval records when expiry would exceed the Date range", (testContext) => {
    const manager = createTestApprovalManager(testContext);
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    expect(() => manager.create({ command: "echo ok" }, 1, "approval-overflow")).toThrow(
      "approval expiry is unavailable",
    );
  });

  it.each(["cancellation", "storage repair"] as const)(
    "lets the deadline win when %s waits for transaction admission",
    async (operation) => {
      installTimerMocks();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-queued-expiry-"));
      tempDirs.push(dir);
      const manager = new ExecApprovalManager({
        persistence: {
          runtimeEpoch: "queued-expiry",
          databaseOptions: { path: path.join(dir, "s.sqlite") },
        },
      });
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
          ? manager.forceDenyDetailed(
              record.id,
              "run-aborted",
              { kind: "system", id: "fixture" },
              "cancelled",
            )
          : manager.resolveDetailed(record.id, "deny", { kind: "system", id: "fixture" });
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

  it("publishes timer-driven timeout expiry through onExpired", async () => {
    const timers = installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    installTestApprovalClock();
    const expirations: Array<{ recordId: string; status: string; requestCommand?: string }> = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-expired-"));
    tempDirs.push(dir);
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "runtime-a",
        databaseOptions: { path: path.join(dir, "s.sqlite") },
      },
      resolveAllowedDecisions: () => ["allow-once", "deny"],
      onExpired: (record, liveRecord) =>
        expirations.push({
          recordId: record.id,
          status: record.status,
          requestCommand: liveRecord.request.command,
        }),
    });
    const record = manager.create({ command: "echo expired" }, 60_000, "approval-on-expired");
    const decisionPromise = (await manager.register(record, 60_000)).decision;
    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);

    const deadlines = timers.filter(({ handle }) => handle.unref.mock.calls.length === 0);
    expect(deadlines).toHaveLength(1);
    const timer = deadlines[0];
    if (!timer || typeof timer.callback !== "function") {
      throw new Error("expected timer callback");
    }
    timer.callback();

    await expect(decisionPromise).resolves.toBeNull();
    // The gateway clock owns expiry: reviewer surfaces get the terminal fact
    // (with the live request for the event payload) instead of inferring it.
    expect(expirations).toEqual([
      { recordId: record.id, status: "expired", requestCommand: "echo expired" },
    ]);
  });

  async function prepareExpiry(testContext: TestContext) {
    const refused = createDeferredCore<unknown>();
    const onExpired = vi.fn();
    const onLifecycle = vi.fn();
    const onError = vi.fn((error: unknown) => refused.resolve(error));
    const { manager, databaseOptions } = await createPreparedTestApprovalManager(testContext, {
      onExpired,
      onLifecycle,
      onError,
    });
    const timers = installTimerMocks();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const record = manager.create({ command: "echo expiry" }, 1_000, "expiry-backpressure");
    const { decision } = await manager.register(record, 1_000);
    const handoff = vi.fn(async () => {});
    const { observation } = manager.registerDecisionHandoff(record.id, handoff);
    const decisionSettled = vi.fn();
    void decision.then(decisionSettled, () => undefined);
    void observation.catch(() => undefined);
    const deadlines = () => timers.filter(({ handle }) => handle.unref.mock.calls.length === 0);
    const invoke = (timer: (typeof timers)[number] | undefined) => {
      expect(timer).toBeDefined();
      if (typeof timer?.callback !== "function") {
        throw new Error("expected approval timer callback");
      }
      timer.callback();
    };
    return {
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
      onLifecycle,
    };
  }

  it.for(["overloaded", "unavailable", "coordinator"] as const)(
    "expires the original waiter after %s admission recovers without a client read",
    async (code, testContext) => {
      const {
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
        onLifecycle,
      } = await prepareExpiry(testContext);
      const capacity =
        code !== "unavailable"
          ? reserveSqliteWorkerInputPreparation(SQLITE_WORKER_MAX_QUEUED_BYTES)
          : undefined;
      if (code === "unavailable") {
        vi.mocked(operatorApprovalStore.forceDenyOperatorApproval).mockRejectedValueOnce(
          new SqliteWorkerError("synthetic pre-execution unavailable", "unavailable"),
        );
      }
      try {
        clock.mockReturnValue(record.expiresAtMs);
        invoke(deadlines()[0]);
        await refused.promise;
        expect(onError.mock.calls[0]?.[0]).toMatchObject({
          code: code === "unavailable" ? "unavailable" : "overloaded",
        });
        expect(decisionSettled).not.toHaveBeenCalled();
        expect(handoff).not.toHaveBeenCalled();
        expect(onExpired).not.toHaveBeenCalled();
        expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
          0,
        );
      } finally {
        capacity?.release();
      }
      expect(deadlines()).toHaveLength(2);
      const retry = deadlines()[1];
      expect(retry?.delay).toBeGreaterThan(0);
      clock.mockReturnValue(record.expiresAtMs + (retry?.delay ?? 0));
      const retryFailure = createDeferredCore<unknown>();
      onError.mockImplementationOnce((error) => retryFailure.resolve(error));
      if (code === "coordinator") {
        const otherCoordinator = path.join(path.dirname(databaseOptions.path), "other-coordinator");
        fs.mkdirSync(otherCoordinator);
        withStateDatabaseCoordinatorRuntimeDirectory(otherCoordinator, () => invoke(retry));
      } else {
        invoke(retry);
      }
      await expect(Promise.race([decision, retryFailure.promise])).resolves.toBeNull();
      await observation;
      expect(handoff).toHaveBeenCalledExactlyOnceWith(null);
      expect(onExpired).toHaveBeenCalledTimes(1);
      expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
        1,
      );
      expect(
        await operatorApprovalStore.getOperatorApprovalDetailed({
          id: record.id,
          databaseOptions,
          nowMs: record.createdAtMs,
        }),
      ).toMatchObject({
        outcome: "found",
        record: { status: "expired", expiresAtMs: 2_000, terminalReason: "timeout" },
      });
    },
  );

  it.for(["retire", "replace"] as const)(
    "does not adopt a new expiry owner after %s",
    async (action, testContext) => {
      const fixture = await prepareExpiry(testContext);
      const { manager, databaseOptions, record, clock, deadlines, invoke, refused, onError } =
        fixture;
      vi.mocked(operatorApprovalStore.forceDenyOperatorApproval).mockRejectedValueOnce(
        new SqliteWorkerError("synthetic pre-execution unavailable", "unavailable"),
      );
      clock.mockReturnValue(record.expiresAtMs);
      invoke(deadlines()[0]);
      await refused.promise;
      expect(deadlines()).toHaveLength(2);
      if (action === "retire") {
        await manager.drain();
        expect(vi.mocked(clearTimeout)).toHaveBeenCalledWith(deadlines()[1]?.handle);
        invoke(deadlines()[1]);
      } else {
        const original = await stat(databaseOptions.path);
        await closeOpenClawStateDatabaseByPathAsync(databaseOptions.path);
        const replacement = `${databaseOptions.path}.expiry-replacement`;
        await copyFile(databaseOptions.path, replacement);
        await rename(replacement, databaseOptions.path);
        expect((await stat(databaseOptions.path)).ino).not.toBe(original.ino);
        const retryRefused = createDeferredCore<unknown>();
        onError.mockImplementationOnce((error) => retryRefused.resolve(error));
        clock.mockReturnValue(record.expiresAtMs + (deadlines()[1]?.delay ?? 0));
        invoke(deadlines()[1]);
        await expect(retryRefused.promise).resolves.toBeInstanceOf(Error);
      }
      expect(fixture.decisionSettled).not.toHaveBeenCalled();
      expect(fixture.onExpired).not.toHaveBeenCalled();
      expect(fixture.handoff).not.toHaveBeenCalled();
      expect(record.resolvedAtMs).toBeUndefined();
      expect(deadlines()).toHaveLength(2);
      expect(
        await operatorApprovalStore.getOperatorApprovalDetailed({
          id: record.id,
          databaseOptions,
          nowMs: record.createdAtMs,
        }),
      ).toMatchObject({ outcome: "found", record: { status: "pending", expiresAtMs: 2_000 } });
    },
  );

  it.for(
    (["resolve", "deny", "cancel", "reconcile"] as const).flatMap((operation) => [
      { operation, replaced: false },
      { operation, replaced: true },
    ]),
  )(
    "retains expiry custody for $operation (replacement: $replaced)",
    async ({ operation, replaced }, testContext) => {
      const fixture = await prepareExpiry(testContext);
      const { manager, databaseOptions, record, clock, invoke, deadlines, refused } = fixture;
      const capacity = reserveSqliteWorkerInputPreparation(SQLITE_WORKER_MAX_QUEUED_BYTES);
      try {
        clock.mockReturnValue(record.expiresAtMs);
        invoke(deadlines()[0]);
        await refused.promise;
      } finally {
        capacity.release();
      }
      expect(deadlines()).toHaveLength(2);
      if (replaced) {
        const original = await stat(databaseOptions.path);
        await closeOpenClawStateDatabaseByPathAsync(databaseOptions.path);
        const replacement = `${databaseOptions.path}.pending-replacement`;
        await copyFile(databaseOptions.path, replacement);
        await rename(replacement, databaseOptions.path);
        expect((await stat(databaseOptions.path)).ino).not.toBe(original.ino);
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
            : manager.forceDenyDetailed(
                record.id,
                operation === "cancel" ? "run-aborted" : "malformed-verdict",
                { kind: "system", id: "fixture" },
                operation === "cancel" ? "cancelled" : "denied",
              );
      const outcome = await transition.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      const stored = await operatorApprovalStore.getOperatorApprovalDetailed({
        id: record.id,
        databaseOptions,
        nowMs: record.createdAtMs,
      });
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
        expect(
          fixture.onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal"),
        ).toHaveLength(0);
      } else {
        expect(outcome.ok).toBe(true);
        const expectedDecision =
          operation === "cancel" ? null : operation === "deny" ? "deny" : "allow-once";
        await expect(fixture.decision).resolves.toBe(expectedDecision);
        await fixture.observation;
        expect(fixture.handoff).toHaveBeenCalledExactlyOnceWith(expectedDecision);
        expect(
          fixture.onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal"),
        ).toHaveLength(1);
        expect(vi.mocked(clearTimeout)).toHaveBeenCalledWith(deadlines()[1]?.handle);
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
      const { manager, databaseOptions, record, clock, invoke, deadlines, refused } = fixture;
      const originalPath = databaseOptions.path;
      const redirected = {
        ...databaseOptions,
        path: path.join(path.dirname(originalPath), "redirected.sqlite"),
      };
      const original = await operatorApprovalStore.getOperatorApprovalDetailed({
        id: record.id,
        databaseOptions,
        nowMs: record.createdAtMs,
      });
      if (original.outcome !== "found") {
        throw new Error("expected original pending row");
      }
      try {
        await operatorApprovalStore.insertOperatorApproval({
          approval: original.record,
          databaseOptions: redirected,
        });
        vi.mocked(operatorApprovalStore.forceDenyOperatorApproval).mockRejectedValueOnce(
          new SqliteWorkerError("synthetic definite refusal", "unavailable"),
        );
        clock.mockReturnValue(record.expiresAtMs);
        invoke(deadlines()[0]);
        await refused.promise;
        clock.mockReturnValue(record.createdAtMs + 500);
        databaseOptions.path = redirected.path;
        if (operation === "resolve") {
          await manager.resolve(record.id, "allow-once");
        } else {
          await manager.forceDenyDetailed(record.id, "malformed-verdict", {
            kind: "system",
            id: "fixture",
          });
        }
        databaseOptions.path = originalPath;
        const expectedStatus = operation === "resolve" ? "allowed" : "denied";
        expect(
          await operatorApprovalStore.getOperatorApprovalDetailed({
            id: record.id,
            databaseOptions,
            nowMs: record.createdAtMs,
          }),
        ).toMatchObject({ outcome: "found", record: { status: expectedStatus } });
        expect(
          await operatorApprovalStore.getOperatorApprovalDetailed({
            id: record.id,
            databaseOptions: redirected,
            nowMs: record.createdAtMs,
          }),
        ).toMatchObject({ outcome: "found", record: { status: "pending" } });
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
      const { record, databaseOptions, clock, invoke, deadlines, refused } = fixture;
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
      clock.mockReturnValue(record.expiresAtMs);
      invoke(deadlines()[0]);
      await expect(refused.promise).resolves.toBeInstanceOf(Error);
      expect(deadlines()).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
      if (failure === "recovered-outcome") {
        await expect(fixture.decision).resolves.toBeNull();
        await fixture.observation;
        expect(fixture.onExpired).toHaveBeenCalledTimes(1);
        expect(fixture.handoff).toHaveBeenCalledExactlyOnceWith(null);
      } else {
        expect(fixture.decisionSettled).not.toHaveBeenCalled();
        expect(fixture.onExpired).not.toHaveBeenCalled();
        expect(fixture.handoff).not.toHaveBeenCalled();
      }
      expect(
        await operatorApprovalStore.getOperatorApprovalDetailed({
          id: record.id,
          databaseOptions,
          nowMs: record.createdAtMs,
        }),
      ).toMatchObject({
        outcome: "found",
        record: {
          status:
            failure === "outcome-unknown" || failure === "recovered-outcome"
              ? "expired"
              : "pending",
        },
      });
    },
  );

  it("rejects ask-fallback replay of a run-aborted cancellation", async (testContext) => {
    installTimerMocks();
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-cancelled");
    const decisionPromise = (await manager.register(record, 60_000)).decision;

    // Dispatch fencing / run abort ends decision-less like a timeout, but its
    // authority closed deliberately — replay must not re-admit through it.
    const denied = await manager.forceDenyDetailed(
      "approval-cancelled",
      "run-aborted",
      { kind: "system", id: "worker-dispatch" },
      "cancelled",
    );
    expect(denied.outcome).toBe("denied");
    await expect(decisionPromise).resolves.toBeNull();

    expect(await manager.getSnapshot("approval-cancelled")).toMatchObject({
      status: "cancelled",
      terminalReason: "run-aborted",
    });
    expect(manager.consumeAskFallback("approval-cancelled")).toBe(false);
  });
});
