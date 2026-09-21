import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { ApprovalObserverClosedError } from "./exec-approval-lifecycle.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import {
  createTestApprovalManager,
  installTestApprovalClock,
} from "./exec-approval-manager.test-support.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import * as operatorApprovalStore from "./operator-approval-store.js";

const managers: ExecApprovalManager[] = [];
const tempDirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  installTestApprovalClock();
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.drain()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await closeOpenClawStateDatabaseByPathAsync(path.join(dir, "state.sqlite"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createManager(
  options: ConstructorParameters<typeof ExecApprovalManager<ExecApprovalRequestPayload>>[0],
) {
  const manager = new ExecApprovalManager(options);
  managers.push(manager);
  return manager;
}

function createPersistentManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-lifetime-"));
  tempDirs.push(dir);
  const databaseOptions = { path: path.join(dir, "state.sqlite") };
  const onExpired = vi.fn();
  const onLifecycle = vi.fn();
  const manager = createManager({
    persistence: { runtimeEpoch: "approval-lifetime", databaseOptions },
    onExpired,
    onLifecycle,
  });
  return { manager, dir, databaseOptions, onExpired, onLifecycle };
}

describe("ExecApprovalManager lifetime", () => {
  it("does not reuse a resolved exact id as a prefix for another pending approval", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const resolvedRecord = manager.create({ command: "echo old", host: "gateway" }, 2_000, "abc");
    await manager.register(resolvedRecord, 2_000);
    expect(await manager.resolve("abc", "allow-once")).toBe(true);

    const pendingRecord = manager.create({ command: "echo new", host: "gateway" }, 2_000, "abcdef");
    await manager.register(pendingRecord, 2_000);

    expect(await manager.lookupApprovalId("abc")).toEqual({ kind: "none" });
    expect(await manager.lookupApprovalId("abcdef")).toEqual({ kind: "exact", id: "abcdef" });
  });

  it("closes only its observers and leaves authority and another manager pending", async (testContext) => {
    const first = createTestApprovalManager(testContext);
    const second = createTestApprovalManager(testContext);
    const firstRecord = first.create({ command: "printf first" }, 60_000, "same-id");
    const secondRecord = second.create({ command: "printf second" }, 60_000, "same-id");
    const authority = (await first.register(firstRecord, 60_000)).decision;
    await second.register(secondRecord, 60_000);
    let authoritySettled = false;
    void authority.then(
      () => {
        authoritySettled = true;
      },
      () => {
        authoritySettled = true;
      },
    );
    const rejected = expect(first.awaitDecision(firstRecord.id)).rejects.toBeInstanceOf(
      ApprovalObserverClosedError,
    );
    const secondWait = second.awaitDecision(secondRecord.id);
    let secondSettled = false;
    void secondWait?.then(() => {
      secondSettled = true;
    });

    first.beginClose();
    await rejected;
    expect(first.getLiveSnapshot(firstRecord.id)?.resolvedAtMs).toBeUndefined();
    expect(authoritySettled).toBe(false);
    expect(secondSettled).toBe(false);
    await first.drain();
    expect(authoritySettled).toBe(false);
    expect(await second.resolve(secondRecord.id, "allow-once")).toBe(true);
    await expect(secondWait).resolves.toBe("allow-once");
  });

  it("abandons failed preparation without deciding authority or retaining its unused handoff", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "printf abandoned" }, 60_000, "abandoned-handoff");
    const authority = (await manager.register(record, 60_000)).decision;
    const afterDecision = vi.fn(async () => {});
    const handoff = manager.registerDecisionHandoff(record.id, afterDecision);
    const rejected = expect(handoff.observation).rejects.toBeInstanceOf(
      ApprovalObserverClosedError,
    );

    handoff.abandon();
    await rejected;
    expect(manager.getLiveSnapshot(record.id)?.resolvedAtMs).toBeUndefined();
    expect(await manager.resolve(record.id, "allow-once")).toBe(true);
    await expect(authority).resolves.toBe("allow-once");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(afterDecision).not.toHaveBeenCalled();
    expect(manager.getLiveSnapshot(record.id)).toBeNull();
  });

  it("retires expiry and held store entry points without changing the durable pending row", async () => {
    const { manager, dir, databaseOptions, onExpired, onLifecycle } = createPersistentManager();
    const originalDatabaseOptions = { ...databaseOptions };
    const record = manager.create({ command: "printf untouched" }, 60_000, "pending-on-close");
    const authority = (await manager.register(record, 60_000)).decision;
    let authoritySettled = false;
    void authority.then(
      () => {
        authoritySettled = true;
      },
      () => {
        authoritySettled = true;
      },
    );
    const before = await getOperatorApprovalDetailed({ id: record.id, databaseOptions });
    if (before.outcome !== "found") {
      throw new Error("expected the registered durable approval");
    }
    const rejected = expect(manager.awaitDecision(record.id)).rejects.toBeInstanceOf(
      ApprovalObserverClosedError,
    );
    manager.retire();
    await Promise.all([rejected, manager.drain()]);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(authoritySettled).toBe(false);
    expect(onExpired).not.toHaveBeenCalled();
    expect(onLifecycle).toHaveBeenCalledOnce();
    // A past read time inspects the stored row without letting the lookup itself expire it.
    expect(
      await getOperatorApprovalDetailed({
        id: record.id,
        nowMs: record.createdAtMs,
        databaseOptions,
      }),
    ).toEqual(before);

    await closeOpenClawStateDatabaseByPathAsync(originalDatabaseOptions.path);
    databaseOptions.path = path.join(dir, "must-not-open", "state.sqlite");
    expect(
      await manager.resolveDetailed(record.id, "deny", { kind: "system", id: "late" }),
    ).toEqual({
      outcome: "not-found",
    });
    expect(
      await manager.forceDenyDetailed(record.id, "run-aborted", { kind: "system", id: "late" }),
    ).toEqual({
      outcome: "not-found",
    });
    expect(await manager.expire(record.id)).toBe(false);
    expect(await manager.resolveAutoReview(record.id)).toBe(false);
    expect(await manager.consumeAllowOnce(record.id)).toBe(false);
    expect(
      await manager.reconcileDurableLookup({ outcome: "found", record: before.record }),
    ).toBeNull();
    expect(await manager.getSnapshot(record.id)).toBeNull();
    expect(await manager.listPendingRecords()).toEqual([]);
    await expect(manager.register(record, 60_000)).rejects.toThrow(ApprovalObserverClosedError);
    expect(() => manager.awaitDecision(record.id)).toThrow(ApprovalObserverClosedError);
    expect(() => manager.create({ command: "printf late" }, 60_000)).toThrow(
      ApprovalObserverClosedError,
    );
    expect(fs.existsSync(path.dirname(databaseOptions.path))).toBe(false);
    expect(
      await getOperatorApprovalDetailed({
        id: record.id,
        nowMs: record.createdAtMs,
        databaseOptions: originalDatabaseOptions,
      }),
    ).toEqual(before);
  });

  it("joins a committed decision and its effect when retirement precedes the worker reply", async () => {
    const { manager, databaseOptions } = createPersistentManager();
    const record = manager.create({ command: "printf committed" }, 60_000, "delayed-reply");
    const { decision } = await manager.register(record, 60_000);
    const committed = createDeferredCore();
    const reply = createDeferredCore();
    const effectStarted = createDeferredCore();
    const finishEffect = createDeferredCore();
    const decisions: unknown[] = [];
    let consumed: boolean | undefined;
    let drained = false;
    const resolve = operatorApprovalStore.resolveOperatorApproval;
    const delayedReply = vi
      .spyOn(operatorApprovalStore, "resolveOperatorApproval")
      .mockImplementationOnce(async (params) => {
        const result = await resolve(params);
        committed.resolve();
        await reply.promise;
        return result;
      });
    const handoff = manager.registerDecisionHandoff(record.id, async (answer) => {
      decisions.push(answer);
      effectStarted.resolve();
      await finishEffect.promise;
      consumed = await manager.consumeAllowOnce(record.id, "delayed-reply-effect");
    });
    const observation = expect(handoff.observation).rejects.toBeInstanceOf(
      ApprovalObserverClosedError,
    );
    const resolution = manager.resolve(record.id, "allow-once");
    let draining: Promise<void> | undefined;
    try {
      await committed.promise;
      manager.retire();
      draining = manager.drain().then(() => {
        drained = true;
      });
      await observation;
      expect(drained).toBe(false);
      reply.resolve();
      await expect(resolution).resolves.toBe(true);
      await effectStarted.promise;
      await expect(decision).resolves.toBe("allow-once");
      expect(decisions).toEqual(["allow-once"]);
      expect(drained).toBe(false);
      finishEffect.resolve();
      await draining;
      expect(consumed).toBe(true);
      expect(await getOperatorApprovalDetailed({ id: record.id, databaseOptions })).toMatchObject({
        outcome: "found",
        record: { status: "allowed", decision: "allow-once", consumedBy: "delayed-reply-effect" },
      });
    } finally {
      reply.resolve();
      finishEffect.resolve();
      manager.beginClose();
      await Promise.allSettled([resolution, observation, draining ?? manager.drain()]);
      delayedReply.mockRestore();
    }
  });

  it("preserves auto-review provenance when terminal reconciliation overtakes the worker reply", async () => {
    const { manager } = createPersistentManager();
    const record = manager.create({ command: "printf reviewed" }, 60_000, "auto-review-reply");
    const { decision } = await manager.register(record, 60_000);
    const resolve = operatorApprovalStore.resolveOperatorApproval;
    const committed = createDeferredCore<Awaited<ReturnType<typeof resolve>>>();
    const reply = createDeferredCore();
    const handoffResults: unknown[] = [];
    const delayedReply = vi
      .spyOn(operatorApprovalStore, "resolveOperatorApproval")
      .mockImplementationOnce(async (params) => {
        const result = await resolve(params);
        committed.resolve(result);
        await reply.promise;
        return result;
      });
    const handoff = manager.registerDecisionHandoff(record.id, async (answer) => {
      handoffResults.push({
        decision: answer,
        resolutionSource: manager.getLiveSnapshot(record.id)?.resolutionSource,
      });
    });
    const resolution = manager.resolveAutoReview(record.id, "approval-runtime");
    let reconciliation: Promise<boolean> | undefined;
    try {
      const durable = await Promise.race([
        committed.promise,
        resolution.then(() => {
          throw new Error("Expected a held worker reply");
        }),
      ]);
      if (durable.outcome !== "resolved") {
        throw new Error("Expected the auto-review decision to commit");
      }
      reconciliation = manager.reconcileDurableTerminal(durable.record);
      reply.resolve();
      await expect(resolution).resolves.toBe(true);
      await reconciliation;
      await expect(decision).resolves.toBe("allow-once");
      await expect(handoff.observation).resolves.toBeUndefined();
      expect(manager.getLiveSnapshot(record.id)).toMatchObject({
        decision: "allow-once",
        resolutionSource: "auto-review",
        resolvedBy: "approval-runtime",
      });
      expect(handoffResults).toEqual([{ decision: "allow-once", resolutionSource: "auto-review" }]);
    } finally {
      reply.resolve();
      await Promise.allSettled([resolution, reconciliation]);
      await manager.drain();
      delayedReply.mockRestore();
    }
  });

  it.for(["allow-once", "expired"] as const)(
    "joins a real %s handoff after its observer leaves and preserves the retained binding",
    async (terminal) => {
      const { manager, databaseOptions } = createPersistentManager();
      const record = manager.create({ command: "printf committed" }, 60_000, "committed-handoff");
      const release = createDeferredCore();
      const decisions: unknown[] = [];
      let consumed: boolean | undefined;
      let bindingRetained = false;
      let drained = false;
      const requester = expectDefined(
        tryBeginGatewayRootWorkAdmission(),
        "approval requester root",
      );
      const { authority, handoff } = await requester
        .run(async () => ({
          authority: (await manager.register(record, 60_000)).decision,
          handoff: manager.registerDecisionHandoff(record.id, async (decision) => {
            decisions.push(decision);
            await release.promise;
            bindingRetained = manager.getLiveSnapshot(record.id) !== null;
            if (decision === "allow-once") {
              consumed = await manager.consumeAllowOnce(record.id, "committed-effect");
            }
          }),
        }))
        .finally(requester.release);
      const rejected = expect(handoff.observation).rejects.toBeInstanceOf(
        ApprovalObserverClosedError,
      );
      let draining: Promise<void> | undefined;
      try {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        manager.beginClose();
        await rejected;
        // Only a real transition retains its resolver root; the pending request stays idle.
        const resolver = expectDefined(
          tryBeginGatewayRootWorkAdmission(),
          "approval resolver root",
        );
        try {
          await resolver.run(async () => {
            expect(
              terminal === "allow-once"
                ? await manager.resolve(record.id, "allow-once")
                : await manager.expire(record.id),
            ).toBe(true);
          });
        } finally {
          resolver.release();
        }
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        draining = manager.drain().then(() => {
          drained = true;
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(drained).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(await manager.consumeAllowOnce(record.id, "late-held-manager")).toBe(false);
        expect(decisions).toEqual([terminal === "allow-once" ? "allow-once" : null]);
        release.resolve();
        await draining;
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(bindingRetained).toBe(true);
        if (terminal === "allow-once") {
          expect(consumed).toBe(true);
        }
        await expect(authority).resolves.toBe(terminal === "allow-once" ? "allow-once" : null);
        expect(await getOperatorApprovalDetailed({ id: record.id, databaseOptions })).toMatchObject(
          {
            outcome: "found",
            record:
              terminal === "allow-once"
                ? { status: "allowed", decision: "allow-once", consumedBy: "committed-effect" }
                : { status: "expired", decision: "deny", terminalReason: "timeout" },
          },
        );
      } finally {
        release.resolve();
        manager.beginClose();
        await Promise.allSettled([rejected, draining ?? manager.drain()]);
      }
    },
  );
});
