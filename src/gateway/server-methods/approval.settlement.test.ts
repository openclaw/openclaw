import { copyFile, rename, stat } from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateGatewayDeviceRevocation } from "../device-revocation.js";
import { ApprovalMutationRefusedError } from "../exec-approval-authority.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { installTestApprovalClock } from "../exec-approval-manager.test-support.js";
import * as approvalRecovery from "../exec-approval-recovery.js";
import * as operatorApprovalStore from "../operator-approval-store.js";
import { createApprovalHandlers } from "./approval.js";
import {
  createApprovalInvocation,
  createClient,
  deleteDurableApproval,
  getOperatorApproval,
} from "./approval.test-support.js";

const resultDelivery = vi.hoisted(() => ({
  loseResult: undefined as "worker" | undefined,
  hideReceipt: false,
  wrapRefusal: false,
  wrappedRefusal: undefined as Error | undefined,
}));
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...args: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
    ) => {
      const admission = actual.createSqliteWorkerOperationAdmission(...args);
      const descriptors = Object.getOwnPropertyDescriptors(admission);
      const readCommitted = expectDefined(descriptors.committed.get, "commit getter");
      const readSettlement = expectDefined(descriptors.settlement.get, "settlement getter");
      vi.spyOn(admission, "committed", "get").mockImplementation(() =>
        resultDelivery.hideReceipt ? undefined : readCommitted.call(admission),
      );
      vi.spyOn(admission, "settlement", "get").mockImplementation(() =>
        resultDelivery.hideReceipt ? undefined : readSettlement.call(admission),
      );
      return admission;
    },
  };
});
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      ...[context, operation, options]: Parameters<typeof actual.runOpenClawStateWorkerOperation>
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope
                .execute(command, executeOptions)
                .catch((error: unknown) => {
                  if (
                    resultDelivery.wrapRefusal &&
                    (command.type === "operatorApprovals.resolve" ||
                      command.type === "operatorApprovals.deny") &&
                    error instanceof Error
                  ) {
                    resultDelivery.wrapRefusal = false;
                    resultDelivery.wrappedRefusal = error;
                    throw withSqliteWorkerCleanupFailure(
                      error,
                      new Error("synthetic cleanup failure"),
                    );
                  }
                  throw error;
                });
              if (
                command.type === "operatorApprovals.resolve" &&
                resultDelivery.loseResult === "worker"
              ) {
                resultDelivery.loseResult = undefined;
                throw new SqliteWorkerError(
                  "synthetic committed result delivery loss",
                  "outcome-unknown",
                );
              }
              return result;
            },
          }),
        options,
      ),
  };
});

let sharedState: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
beforeAll(async () => {
  sharedState = await createOpenClawTestState({ label: "approval-uncertain-settlement" });
});
beforeEach(() => sharedState?.applyEnv());
afterEach(() => {
  Object.assign(resultDelivery, {
    loseResult: undefined,
    hideReceipt: false,
    wrapRefusal: false,
    wrappedRefusal: undefined,
  });
  vi.restoreAllMocks();
});
afterAll(async () => sharedState?.cleanup());

async function createFixture(
  runtimeEpoch: string,
  resolveDecisions = false,
  bindDatabase = true,
  deviceId: string | null = "reviewer",
) {
  const state = expectDefined(sharedState, "shared approval test state");
  const reviewerId = deviceId ?? "reviewer";
  const databaseOptions = { env: state.env };
  const persistence = { runtimeEpoch, ...(bindDatabase ? { databaseOptions } : {}) };
  const onLifecycle = vi.fn();
  const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
    scheduler: createTestGatewayScheduler(),
    persistence,
    onLifecycle,
    resolveAllowedDecisions: resolveDecisions
      ? resolveExecApprovalRequestAllowedDecisions
      : undefined,
  });
  const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
    scheduler: createTestGatewayScheduler(),
    approvalKind: "plugin",
    persistence,
  });
  const record = exec.create({ command: "echo approval" }, 600_000);
  if (deviceId) {
    record.approvalReviewerDeviceIds = [deviceId];
  }
  const { decision } = await exec.register(record, 600_000);
  const settlement: { done: boolean; value?: string | null } = { done: false };
  void decision.then((value) => {
    settlement.done = true;
    settlement.value = value;
  });
  const handlers = createApprovalHandlers({
    execApprovalManager: exec,
    pluginApprovalManager: plugin,
    databaseOptions,
  });
  const get = () =>
    createApprovalInvocation({
      handlers,
      method: "approval.get",
      body: { id: record.id },
      client: createClient({ deviceId: reviewerId }),
    }).invoke();
  return {
    state,
    deviceId: reviewerId,
    databaseOptions,
    persistence,
    exec,
    record,
    decision,
    settlement,
    databasePath: resolveOpenClawStateSqlitePath(state.env),
    read: (nowMs?: number) => getOperatorApproval({ id: record.id, databaseOptions, nowMs }),
    get,
    resolveInvocation: (operation: "resolve" | "deny", signal?: AbortSignal) => {
      const client = createClient({ deviceId: reviewerId });
      client.connectionSignal = signal;
      return createApprovalInvocation({
        handlers,
        method: "approval.resolve",
        client,
        body: {
          id: record.id,
          kind: "exec",
          decision: operation === "resolve" ? "allow-once" : "invalid",
        },
      });
    },
    expectGet: async (status: string) =>
      expect(await get()).toMatchObject({
        ok: true,
        result: { approval: { status } },
      }),
    expectTerminal: (count: number) =>
      expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
        count,
      ),
    async [Symbol.asyncDispose]() {
      await Promise.all([exec.drain(), plugin.drain()]);
    },
  };
}

function unavailableReadback() {
  vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockRejectedValueOnce(
    new SqliteWorkerError("synthetic readback unavailable", "unavailable"),
  );
}

function unconfirmedVerdict(message: string) {
  vi.spyOn(operatorApprovalStore, "resolveOperatorApproval").mockRejectedValueOnce(
    new SqliteWorkerError(message, "outcome-unknown"),
  );
}

function loseResolveReply(afterWrite: () => void | Promise<void>, committed = true) {
  const resolve = operatorApprovalStore.resolveOperatorApproval;
  vi.spyOn(operatorApprovalStore, "resolveOperatorApproval").mockImplementationOnce(
    async (input) => {
      if (committed) {
        await resolve(input);
      }
      const pending = afterWrite();
      if (pending) {
        await pending;
      }
      throw new SqliteWorkerError("synthetic reply lost after real commit", "outcome-unknown");
    },
  );
}

async function replaceDatabase(databasePath: string) {
  const original = await stat(databasePath);
  await closeOpenClawStateDatabaseByPathAsync(databasePath);
  const replacement = `${databasePath}.replacement`;
  await copyFile(databasePath, replacement);
  await rename(replacement, databasePath);
  expect((await stat(databasePath)).ino).not.toBe(original.ino);
}

it.each(["resolve", "deny"] as const)(
  "preserves %s refusal inside cleanup aggregates",
  async (operation) => {
    await using fixture = await createFixture("aggregate-refusal", true);
    const { record, settlement, deviceId } = fixture;
    const before = fixture.read();
    const connection = new AbortController();
    const invocation = fixture.resolveInvocation(operation, connection.signal);
    let transactions = 0;
    probe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "transaction") {
        transactions += 1;
        if (transactions === 1) {
          connection.abort();
        }
      } else if (request.stage === "commit" && transactions === 2) {
        invalidateGatewayDeviceRevocation(invocation.context, deviceId, "operator");
      }
      return admit(request, grant);
    });
    resultDelivery.wrapRefusal = true;
    expect(await invocation.invoke()).toMatchObject({ ok: false });
    expect(transactions).toBe(2);
    expect(resultDelivery.wrappedRefusal).toBeInstanceOf(ApprovalMutationRefusedError);
    expect(fixture.read()).toEqual(before);
    expect(settlement.done).toBe(false);
    expect(record.resolvedAtMs).toBeUndefined();
    expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
  },
);

it.each([false, true])("keeps missing-row owner (replaced: %s)", async (replace) => {
  await using fixture = await createFixture("missing-owner");
  const { databaseOptions, exec, record, decision, settlement, databasePath } = fixture;
  unconfirmedVerdict("synthetic uncertain original verdict");
  unavailableReadback();
  await expect(exec.resolveAutoReview(record.id)).rejects.toThrow("verdict remains uncertain");
  if (replace) {
    await replaceDatabase(databasePath);
  }
  deleteDurableApproval(databaseOptions, record.id);
  expect(await fixture.get()).toMatchObject({ ok: false });
  if (replace) {
    expect(settlement.done).toBe(false);
    expect(record.resolvedAtMs).toBeUndefined();
  } else {
    await expect(decision).resolves.toBe("deny");
    expect(record.terminalReason).toBe("storage-corrupt");
  }
});

it.each(["resolve", "cancel", "expire"] as const)(
  "retains uncertain owner before %s retry",
  async (operation) => {
    await using fixture = await createFixture("retry-owner", false, true, null);
    const { exec: manager, record, settlement, databasePath } = fixture;
    unconfirmedVerdict("synthetic unconfirmed original verdict");
    unavailableReadback();
    await expect(manager.resolveAutoReview(record.id)).rejects.toThrow("verdict remains uncertain");
    const before = fixture.read(record.createdAtMs);
    await replaceDatabase(databasePath);
    if (operation === "expire") {
      vi.spyOn(Date, "now").mockReturnValue(record.expiresAtMs);
      installTestApprovalClock();
    }
    const retry =
      operation === "resolve"
        ? manager.resolve(record.id, "allow-once")
        : operation === "cancel"
          ? manager.forceDenyDetailed(
              record.id,
              "run-aborted",
              { kind: "system", id: null },
              "cancelled",
            )
          : manager.getSnapshot(record.id);
    const failure = await retry.catch((error: unknown) => error);
    expect(fixture.read(record.createdAtMs)).toEqual(before);
    expect(settlement.done).toBe(false);
    expect(record.resolvedAtMs).toBeUndefined();
    fixture.expectTerminal(0);
    expect(failure).toBeInstanceOf(Error);
    if (operation === "cancel") {
      expect(record.approvalAuthority?.()).toBe(false);
    }
  },
);

it.each(["worker", "native", "missing-receipt"] as const)(
  "requires commit receipts after %s result loss",
  async (variant) => {
    await using fixture = await createFixture("receipt-custody");
    const { exec: manager, record, decision, settlement } = fixture;
    const readback = vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed");
    resultDelivery.loseResult = "worker";
    resultDelivery.hideReceipt = variant === "missing-receipt";
    await expect(
      manager.resolveAutoReview(
        record.id,
        null,
        undefined,
        variant === "native"
          ? {
              family: "native-compatibility",
              assertCurrent() {},
            }
          : undefined,
      ),
    ).rejects.toThrow("synthetic committed result delivery loss");
    expect(readback).toHaveBeenCalledTimes(1);
    expect(fixture.read()).toMatchObject({
      status: "allowed",
      decision: "allow-once",
    });
    if (variant === "missing-receipt") {
      expect(settlement.done).toBe(false);
      resultDelivery.hideReceipt = false;
      resultDelivery.loseResult = "worker";
      await expect(manager.resolve(record.id, "allow-once")).rejects.toThrow(
        "synthetic committed result delivery loss",
      );
      await fixture.expectGet("allowed");
      expect(settlement.done).toBe(false);
      expect(record.resolutionSource).toBeUndefined();
      fixture.expectTerminal(0);
    } else {
      await expect(decision).resolves.toBe("allow-once");
      expect(record.resolutionSource).toBe("auto-review");
      fixture.expectTerminal(1);
    }
  },
);

it.each([
  ["channel", true, "channel-winner"],
  ["runtime", false, null],
  ["runtime", true, null],
] as const)("keeps uncertain attribution (%s, unavailable=%s)", async (kind, unavailable, id) => {
  await using fixture = await createFixture("competing-review-custody");
  const { databaseOptions, persistence, exec, record, decision, settlement } = fixture;
  const resolve = operatorApprovalStore.resolveOperatorApproval;
  unconfirmedVerdict("synthetic unconfirmed auto-review");
  if (unavailable) {
    unavailableReadback();
  }
  await expect(exec.resolveAutoReview(record.id)).rejects.toThrow(
    unavailable ? "verdict remains uncertain" : "synthetic unconfirmed auto-review",
  );
  expect(settlement.done).toBe(false);
  expect(
    await resolve({
      id: record.id,
      decision: "allow-once",
      resolver: { kind, id },
      runtimeEpoch: persistence.runtimeEpoch,
      expectedKind: "exec",
      databaseOptions,
    }),
  ).toMatchObject({ outcome: "resolved" });
  await fixture.expectGet("allowed");
  if (kind === "runtime" && unavailable) {
    expect(settlement.done).toBe(false);
    expect(record.resolutionSource).toBeUndefined();
    fixture.expectTerminal(0);
  } else {
    await expect(decision).resolves.toBe("allow-once");
    expect(record.resolutionSource).toBe("operator");
    fixture.expectTerminal(1);
  }
});

it.each(["before-readback", "before-local-settlement"] as const)(
  "does not settle across replacement %s",
  async (replacementStage) => {
    await using fixture = await createFixture("replacement-custody", false, true, null);
    const { exec: manager, record, settlement, databasePath } = fixture;
    loseResolveReply(() =>
      replacementStage === "before-readback" ? replaceDatabase(databasePath) : undefined,
    );
    if (replacementStage === "before-local-settlement") {
      const readback = approvalRecovery.readUncertainExecApprovalVerdict;
      vi.spyOn(approvalRecovery, "readUncertainExecApprovalVerdict").mockImplementationOnce(
        async (...args) => {
          const result = await readback(...args);
          await replaceDatabase(databasePath);
          return result;
        },
      );
    }
    const failure = await manager.resolve(record.id, "allow-once").catch((error: unknown) => error);
    expect(fixture.read()).toMatchObject({
      id: record.id,
      runtimeEpoch: "replacement-custody",
      createdAtMs: record.createdAtMs,
      status: "allowed",
      decision: "allow-once",
    });
    expect(settlement.done).toBe(false);
    expect(record.resolvedAtMs).toBeUndefined();
    fixture.expectTerminal(0);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toHaveProperty("message", "Approval verdict remains uncertain after readback");
  },
);

it.each(["resolve", "deny"] as const)(
  "settles committed %s despite lost reply and revocation",
  async (operation) => {
    await using fixture = await createFixture("lost-reply-test", true);
    const { record, settlement, deviceId } = fixture;
    const invocation = fixture.resolveInvocation(operation);
    const loseReply = async (write: () => Promise<unknown>) => {
      await write();
      invalidateGatewayDeviceRevocation(invocation.context, deviceId, "operator");
      throw new SqliteWorkerError("synthetic reply lost after real commit", "outcome-unknown");
    };
    if (operation === "resolve") {
      const resolve = operatorApprovalStore.resolveOperatorApproval;
      vi.spyOn(operatorApprovalStore, "resolveOperatorApproval").mockImplementationOnce((input) =>
        loseReply(() => resolve(input)),
      );
    } else {
      const deny = operatorApprovalStore.forceDenyOperatorApproval;
      vi.spyOn(operatorApprovalStore, "forceDenyOperatorApproval").mockImplementationOnce((input) =>
        loseReply(() => deny(input)),
      );
    }
    expect(await invocation.invoke()).toMatchObject({ ok: false });
    const expectedDecision = operation === "resolve" ? "allow-once" : "deny";
    expect(fixture.read()).toMatchObject({
      status: operation === "resolve" ? "allowed" : "denied",
      decision: expectedDecision,
    });
    expect(settlement.value).toBe(expectedDecision);
    expect(record.decision).toBe(expectedDecision);
    fixture.expectTerminal(1);
    expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
  },
);

it.each([
  "readback-unavailable",
  "target-changed",
  "auto-review-readback-unavailable",
  "auto-review-retry",
  "auto-review-not-committed",
  "auto-review-not-committed-readback-unavailable",
] as const)("preserves uncertain verdict custody for %s", async (variant) => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const autoReview = variant.startsWith("auto-review");
  const uncommitted = variant.startsWith("auto-review-not-committed");
  const unavailable = variant.endsWith("readback-unavailable") || variant === "auto-review-retry";
  await using fixture = await createFixture(
    "uncertain-custody-test",
    true,
    variant !== "target-changed",
  );
  const { state, exec, record, settlement } = fixture;
  loseResolveReply(() => {
    if (variant === "target-changed") {
      process.env.OPENCLAW_STATE_DIR = `${expectDefined(state.env.OPENCLAW_STATE_DIR, "test state directory")}/moved`;
    }
    if (unavailable) {
      unavailableReadback();
    }
  }, !uncommitted);
  try {
    await expect(
      autoReview
        ? exec.resolveAutoReview(record.id, "synthetic-runtime")
        : exec.resolve(record.id, "allow-once"),
    ).rejects.toThrow(unavailable ? "verdict remains uncertain" : "synthetic reply lost");
    expect(fixture.read()).toMatchObject(
      uncommitted
        ? { status: "pending", decision: null }
        : { status: "allowed", decision: "allow-once" },
    );
    if (uncommitted) {
      expect(settlement.value).toBeUndefined();
      expect(await exec.resolve(record.id, "allow-once", "confirmed-operator")).toBe(true);
    } else if (unavailable) {
      expect(settlement.value).toBeUndefined();
      expect(record.resolvedAtMs).toBeUndefined();
      if (variant === "auto-review-retry") {
        expect(await exec.resolve(record.id, "allow-once", "operator-retry")).toBe(false);
      } else {
        await fixture.expectGet("allowed");
      }
    }
    expect(settlement.value).toBe("allow-once");
    expect(record.resolutionSource).toBe(autoReview && !uncommitted ? "auto-review" : "operator");
    fixture.expectTerminal(1);
  } finally {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  }
});

it.each([false, true])("retains no-route fallback (unavailable: %s)", async (unavailable) => {
  await using fixture = await createFixture("no-route-recovery", true);
  const { exec, record, settlement } = fixture;
  const deny = operatorApprovalStore.forceDenyOperatorApproval;
  vi.spyOn(operatorApprovalStore, "forceDenyOperatorApproval").mockImplementationOnce(
    async (input) => {
      await deny(input);
      if (unavailable) {
        unavailableReadback();
      }
      throw new SqliteWorkerError("synthetic no-route reply lost", "outcome-unknown");
    },
  );
  await expect(exec.expire(record.id, "no-approval-route")).rejects.toThrow();
  expect(fixture.read()).toMatchObject({
    status: "denied",
    decision: "deny",
    terminalReason: "no-route",
  });
  if (unavailable) {
    expect(settlement.value).toBeUndefined();
    await fixture.expectGet("denied");
  }
  expect(settlement.value).toBeNull();
  expect(record.decision).toBeUndefined();
  expect(exec.consumeAskFallback(record.id)).toBe(true);
  expect(exec.consumeAskFallback(record.id)).toBe(false);
});
