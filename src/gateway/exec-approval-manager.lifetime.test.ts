import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { loadCronJobsStore } from "../cron/store.js";
import {
  CronStreamExecApprovalRequiredError,
  cronStreamExecApprovalBinding,
} from "../cron/stream-exec-authority.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ApprovalObserverClosedError } from "./exec-approval-lifecycle.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import {
  createTestApprovalFixture,
  createTestApprovalManager,
  installTestApprovalClock,
} from "./exec-approval-manager.test-support.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import * as operatorApprovalStore from "./operator-approval-store.js";
import { consumeOperatorApprovalAllowOnceInDatabase } from "./operator-approval-store.transitions.worker.js";

const managers: ExecApprovalManager[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  installTestApprovalClock();
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.drain()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function createPersistentManager(test: TestContext, register = true) {
  const onExpired = vi.fn();
  const onLifecycle = vi.fn();
  const { manager, databaseOptions } = createTestApprovalFixture(test, { onExpired, onLifecycle });
  managers.push(manager);
  const dir = path.dirname(databaseOptions.path);
  const record = manager.create({ command: "printf fixture" }, 60_000, "approval");
  const decision = register ? (await manager.register(record, 60_000)).decision : null;
  const read = (options = databaseOptions, nowMs?: number) =>
    getOperatorApprovalDetailed({ id: record.id, databaseOptions: options, nowMs });
  return { manager, dir, databaseOptions, onExpired, onLifecycle, record, decision, read };
}

const expectClosed = (promise: Promise<unknown> | null) =>
  expect(promise).rejects.toBeInstanceOf(ApprovalObserverClosedError);

function observeSettlement(promise: Promise<unknown> | null) {
  const settled = vi.fn();
  void promise?.then(settled, settled);
  return settled;
}

async function withRootAdmission<T>(run: () => Promise<T>) {
  const root = expectDefined(tryBeginGatewayRootWorkAdmission(), "approval root");
  try {
    return await root.run(run);
  } finally {
    root.release();
  }
}

function holdResolutionReply() {
  const resolve = operatorApprovalStore.resolveOperatorApproval;
  const committed = createDeferredCore<Awaited<ReturnType<typeof resolve>>>();
  const reply = createDeferredCore();
  const delayedReply = vi
    .spyOn(operatorApprovalStore, "resolveOperatorApproval")
    .mockImplementationOnce(async (params) => {
      const result = await resolve(params);
      committed.resolve(result);
      await reply.promise;
      return result;
    });
  return { committed, reply, delayedReply };
}

describe("ExecApprovalManager lifetime", () => {
  it("rolls back prepared consumption with its effect and publishes only committed consumption", async (test) => {
    const { manager, databaseOptions } = await createPersistentManager(test);
    const record = manager.create({ command: "tail -F app.log" }, 60_000);
    await manager.register(record, 60_000);
    await manager.resolveDetailed(record.id, "allow-once", { kind: "device", id: "control-ui" });
    const prepared = manager.prepareConsumeAllowOnce(record.id, "cron.add:watcher");
    if (!prepared) {
      throw new Error("expected live approval consumption");
    }
    const consume = () =>
      runOpenClawStateWriteTransaction((database) => {
        prepared.assertCurrent();
        const result = consumeOperatorApprovalAllowOnceInDatabase({
          ...prepared.input,
          databaseOptions: { database },
        });
        if (result.outcome !== "consumed") {
          throw new Error(`expected consumption, got ${result.outcome}`);
        }
        prepared.assertCurrent();
        return result.record;
      }, databaseOptions);

    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        consume();
        throw new Error("effect refused");
      }, databaseOptions),
    ).toThrow("effect refused");
    expect(await getOperatorApprovalDetailed({ id: record.id, databaseOptions })).toMatchObject({
      outcome: "found",
      record: { decision: "allow-once", consumedAtMs: null },
    });
    expect(manager.getLocalSnapshot(record.id)?.consumedDecision).toBeUndefined();

    const committed = consume();
    prepared.markCommitted(committed);
    expect(manager.getLocalSnapshot(record.id)).toMatchObject({
      decision: "allow-once",
      consumedDecision: "allow-once",
      consumedBy: "cron.add:watcher",
    });
    expect(await getOperatorApprovalDetailed({ id: record.id, databaseOptions })).toMatchObject({
      outcome: "found",
      record: { decision: "allow-once", consumedBy: "cron.add:watcher" },
    });
    expect(manager.prepareConsumeAllowOnce(record.id, "cron.add:another-watcher")).toBeNull();
    expect(() => prepared.assertCurrent()).toThrow("approval authority is no longer active");
  });

  it.for(["run closes", "grace expires", "manager retires"] as const)(
    "fences prepared consumption when %s before the effect commits",
    async (change, test) => {
      let active = true;
      const { manager, databaseOptions } = await createPersistentManager(test);
      const record = manager.create({ command: "tail -F app.log" }, 60_000);
      record.approvalAuthority = () => active;
      await manager.register(record, 60_000);
      await manager.resolveDetailed(record.id, "allow-once", { kind: "device", id: "control-ui" });
      const prepared = manager.prepareConsumeAllowOnce(record.id, "cron.add:watcher");
      if (!prepared) {
        throw new Error("expected live approval consumption");
      }
      if (change === "run closes") {
        active = false;
      } else if (change === "grace expires") {
        vi.setSystemTime(Date.now() + 15_000);
      } else {
        manager.retire();
      }

      expect(() => prepared.assertCurrent()).toThrow("approval authority is no longer active");
      expect(await getOperatorApprovalDetailed({ id: record.id, databaseOptions })).toMatchObject({
        outcome: "found",
        record: { decision: "allow-once", consumedAtMs: null },
      });
    },
  );

  it.for(["current", "revoked"] as const)(
    "settles a borrowed %s approval with its cron write after storage preparation waits",
    async (authority) => {
      await withOpenClawTestState({ label: "borrowed-cron-approval" }, async (state) => {
        const scheduler = createTestGatewayScheduler("fake-timers");
        const manager = new ExecApprovalManager({
          scheduler,
          persistence: { runtimeEpoch: "borrowed-cron-approval" },
        });
        const storePath = state.statePath("cron", "jobs.json");
        const cron = new CronService({
          scheduler,
          nowMs: () => Date.now(),
          storePath,
          cronEnabled: false,
          defaultAgentId: "main",
          cronConfig: { triggers: { enabled: true } },
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: async () => ({ status: "ok" }),
        });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const effect = createDeferredCore<{ ok: true } | { ok: false; error: unknown }>();
        const runId = `borrowed-cron-${authority}`;
        const admission = prepareAgentRunAdmission({
          cfg: {},
          operationalRunInstance: createOperationalRunInstanceRef(runId),
          facts: {
            runId,
            agentId: "main",
            ingress: { kind: "system", state: "present", boundary: "borrowed-cron-approval" },
          },
        });
        let handoff: ReturnType<typeof manager.registerDecisionHandoff> | undefined;
        try {
          const job = await cron.add({
            name: "Borrowed approval watcher",
            enabled: false,
            schedule: { kind: "stream", command: ["synthetic-source"] },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "Synthetic event" },
          });
          const policyKey = "borrowed-watcher-policy";
          const execPolicy = {
            kind: "resolved" as const,
            assertCurrent: (approvedPolicyKey?: string) => {
              if (approvedPolicyKey !== policyKey) {
                throw new CronStreamExecApprovalRequiredError(policyKey, "full", "always");
              }
            },
          };
          const proposal = await cron.update(job.id, { enabled: true }, { execPolicy }).then(
            () => {
              throw new Error("Expected approval before enabling the watcher");
            },
            (error: unknown) => {
              if (!(error instanceof CronStreamExecApprovalRequiredError) || !error.mutation) {
                throw error;
              }
              return error.mutation;
            },
          );
          const before = await loadCronJobsStore(storePath);
          const record = manager.create({ command: "synthetic-source" }, 60_000);
          record.approvalAuthority = expectDefined(
            resolveAdmittedRunActiveAssertion(await admission.admit("embedded")),
            "live creator authority",
          );
          await manager.register(record, 60_000);
          sqliteWorkerOwnerProbe.command(stateWorker, async (command, options, scope) => {
            if (command.type === "cron.mutateJobs") {
              entered.resolve();
              await release.promise;
            }
            return await scope.execute(command, options);
          });
          handoff = manager.registerDecisionHandoff(record.id, async (decision) => {
            try {
              expect(decision).toBe("allow-once");
              const consumption = expectDefined(
                manager.prepareConsumeAllowOnce(record.id, `cron.update:${job.id}`),
                "borrowed approval consumption",
              );
              await cron.update(
                job.id,
                { enabled: true },
                {
                  execPolicy,
                  streamExecApproval: {
                    policyKey,
                    binding: cronStreamExecApprovalBinding(proposal),
                    consumption,
                  },
                },
              );
              effect.resolve({ ok: true });
            } catch (error) {
              effect.resolve({ ok: false, error });
            }
          });
          await manager.resolve(record.id, "allow-once");
          expect(
            await Promise.race([
              entered.promise.then(() => "storage-wait"),
              effect.promise.then(() => "effect-settled"),
            ]),
          ).toBe("storage-wait");
          manager.retire();
          if (authority === "revoked") {
            admission.close();
          }
          release.resolve();
          const outcome = await effect.promise;
          await handoff.observation;
          const stored = await getOperatorApprovalDetailed({ id: record.id });
          if (authority === "current") {
            expect(outcome).toEqual({ ok: true });
            expect((await loadCronJobsStore(storePath)).jobs).toMatchObject([
              { id: job.id, enabled: true },
            ]);
            expect(stored).toMatchObject({
              outcome: "found",
              record: { decision: "allow-once", consumedBy: `cron.update:${job.id}` },
            });
            expect(record.consumedDecision).toBe("allow-once");
          } else {
            expect(outcome).toMatchObject({
              ok: false,
              error: { message: "approval authority is no longer active" },
            });
            expect(await loadCronJobsStore(storePath)).toEqual(before);
            expect(stored).toMatchObject({
              outcome: "found",
              record: { decision: "allow-once", consumedAtMs: null },
            });
            expect(record.consumedDecision).toBeUndefined();
          }
        } finally {
          admission.close();
          release.resolve();
          handoff?.abandon();
          await manager.drain();
          cron.stop();
          await cron.waitForIdle();
          await scheduler.stop();
        }
      });
    },
  );

  it.for(["authority", "signal", "retirement"] as const)(
    "refuses insertion when %s closes during audience preparation",
    async (closed, testContext) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const controller = new AbortController();
      let active = true;
      const onLifecycle = vi.fn();
      const manager = createTestApprovalManager(testContext, {
        resolveAudienceSessionKeys: async (source) => {
          entered.resolve();
          await release.promise;
          return [source];
        },
        onLifecycle,
      });
      const record = manager.create(
        { command: "printf prepared", sessionKey: "agent:main:child" },
        60_000,
        "approval-preparation-authority",
      );
      record.approvalAuthority = () => active;
      record.approvalSignals = [controller.signal];
      const insert = vi.spyOn(operatorApprovalStore, "insertOperatorApproval");
      const pending = manager.register(record, 60_000);
      const rejected = expect(pending).rejects.toThrow(
        closed === "retirement"
          ? "Gateway approval observer closed"
          : "approval authority is no longer active",
      );
      try {
        await entered.promise;
        if (closed === "authority") {
          active = false;
        } else if (closed === "signal") {
          controller.abort();
        } else {
          manager.retire();
        }
        release.resolve();
        await rejected;
        expect(insert).not.toHaveBeenCalled();
        expect(onLifecycle).not.toHaveBeenCalled();
        expect(manager.getLiveSnapshot(record.id)).toBeNull();
      } finally {
        release.resolve();
        await Promise.allSettled([pending, rejected]);
        insert.mockRestore();
      }
    },
  );

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
    const authoritySettled = observeSettlement(authority);
    const rejected = expectClosed(first.awaitDecision(firstRecord.id));
    const secondWait = second.awaitDecision(secondRecord.id);
    const secondSettled = observeSettlement(secondWait);

    first.beginClose();
    await rejected;
    expect(first.getLiveSnapshot(firstRecord.id)?.resolvedAtMs).toBeUndefined();
    expect(authoritySettled).not.toHaveBeenCalled();
    expect(secondSettled).not.toHaveBeenCalled();
    await first.drain();
    expect(authoritySettled).not.toHaveBeenCalled();
    expect(await second.resolve(secondRecord.id, "allow-once")).toBe(true);
    await expect(secondWait).resolves.toBe("allow-once");
  });

  it("abandons failed preparation without deciding authority or retaining its unused handoff", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "printf abandoned" }, 60_000, "abandoned-handoff");
    const authority = (await manager.register(record, 60_000)).decision;
    const afterDecision = vi.fn(async () => {});
    const handoff = manager.registerDecisionHandoff(record.id, afterDecision);
    const rejected = expectClosed(handoff.observation);

    handoff.abandon();
    await rejected;
    expect(manager.getLiveSnapshot(record.id)?.resolvedAtMs).toBeUndefined();
    expect(await manager.resolve(record.id, "allow-once")).toBe(true);
    await expect(authority).resolves.toBe("allow-once");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(afterDecision).not.toHaveBeenCalled();
    expect(manager.getLiveSnapshot(record.id)).toBeNull();
  });

  it("retires expiry and held store entry points without changing the durable pending row", async (test) => {
    const { manager, dir, databaseOptions, onExpired, onLifecycle, record, decision, read } =
      await createPersistentManager(test);
    const originalDatabaseOptions = { ...databaseOptions };
    const authoritySettled = observeSettlement(decision);
    const before = await read();
    if (before.outcome !== "found") {
      throw new Error("expected the registered durable approval");
    }
    const rejected = expectClosed(manager.awaitDecision(record.id));
    manager.retire();
    await Promise.all([rejected, manager.drain()]);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(authoritySettled).not.toHaveBeenCalled();
    expect(onExpired).not.toHaveBeenCalled();
    expect(onLifecycle).toHaveBeenCalledOnce();
    // A past read time inspects the stored row without letting the lookup itself expire it.
    expect(await read(databaseOptions, record.createdAtMs)).toEqual(before);

    await closeOpenClawStateDatabaseByPathAsync(originalDatabaseOptions.path);
    databaseOptions.path = path.join(dir, "must-not-open", "state.sqlite");
    const resolver = { kind: "system", id: "late" } as const;
    expect({
      resolve: await manager.resolveDetailed(record.id, "deny", resolver),
      deny: await manager.forceDenyDetailed(record.id, "run-aborted", resolver),
      expire: await manager.expire(record.id),
      review: await manager.resolveAutoReview(record.id),
      consume: await manager.consumeAllowOnce(record.id),
      reconcile: await manager.reconcileDurableLookup({ outcome: "found", record: before.record }),
      snapshot: await manager.getSnapshot(record.id),
      pending: await manager.listPendingRecords(),
    }).toEqual({
      resolve: { outcome: "not-found" },
      deny: { outcome: "not-found" },
      expire: false,
      review: false,
      consume: false,
      reconcile: null,
      snapshot: null,
      pending: [],
    });
    await expect(manager.register(record, 60_000)).rejects.toThrow(ApprovalObserverClosedError);
    expect(() => manager.awaitDecision(record.id)).toThrow(ApprovalObserverClosedError);
    expect(() => manager.create({ command: "printf late" }, 60_000)).toThrow(
      ApprovalObserverClosedError,
    );
    expect(fs.existsSync(path.dirname(databaseOptions.path))).toBe(false);
    expect(await read(originalDatabaseOptions, record.createdAtMs)).toEqual(before);
  });

  it("joins a committed decision and its effect when retirement precedes the worker reply", async (test) => {
    const { manager, record, decision, read } = await createPersistentManager(test);
    const { committed, reply, delayedReply } = holdResolutionReply();
    const effectStarted = createDeferredCore();
    const finishEffect = createDeferredCore();
    const decisions: unknown[] = [];
    let consumed: boolean | undefined;
    let drained = false;
    const handoff = manager.registerDecisionHandoff(record.id, async (answer) => {
      decisions.push(answer);
      effectStarted.resolve();
      await finishEffect.promise;
      consumed = await manager.consumeAllowOnce(record.id, "delayed-reply-effect");
    });
    const observation = expectClosed(handoff.observation);
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
      expect(await read()).toMatchObject({
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

  it("preserves auto-review provenance when terminal reconciliation overtakes the worker reply", async (test) => {
    const { manager, record, decision } = await createPersistentManager(test);
    const { committed, reply, delayedReply } = holdResolutionReply();
    const handoffResults: unknown[] = [];
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
    async (terminal, test) => {
      const { manager, record, read } = await createPersistentManager(test, false);
      const release = createDeferredCore();
      const decisions: unknown[] = [];
      let consumed: boolean | undefined;
      let bindingRetained = false;
      let drained = false;
      const { authority, handoff } = await withRootAdmission(async () => ({
        authority: (await manager.register(record, 60_000)).decision,
        handoff: manager.registerDecisionHandoff(record.id, async (decision) => {
          decisions.push(decision);
          await release.promise;
          bindingRetained = manager.getLiveSnapshot(record.id) !== null;
          if (decision === "allow-once") {
            consumed = await manager.consumeAllowOnce(record.id, "committed-effect");
          }
        }),
      }));
      const rejected = expectClosed(handoff.observation);
      let draining: Promise<void> | undefined;
      try {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        manager.beginClose();
        await rejected;
        // Only a real transition retains its resolver root; the pending request stays idle.
        await withRootAdmission(async () => {
          expect(
            terminal === "allow-once"
              ? await manager.resolve(record.id, "allow-once")
              : await manager.expire(record.id),
          ).toBe(true);
        });
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
        expect(await read()).toMatchObject({
          outcome: "found",
          record:
            terminal === "allow-once"
              ? { status: "allowed", decision: "allow-once", consumedBy: "committed-effect" }
              : { status: "expired", decision: "deny", terminalReason: "timeout" },
        });
      } finally {
        release.resolve();
        manager.beginClose();
        await Promise.allSettled([rejected, draining ?? manager.drain()]);
      }
    },
  );
});
