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
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
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
  loseResult: undefined as "worker" | "native" | undefined,
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
    ) =>
      new Proxy(actual.createSqliteWorkerOperationAdmission(...args), {
        get(target, key, receiver) {
          return resultDelivery.hideReceipt && (key === "committed" || key === "settlement")
            ? undefined
            : Reflect.get(target, key, receiver);
        },
      }),
  };
});
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
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
vi.mock("../operator-approval-store.native.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../operator-approval-store.native.js")>();
  return {
    ...actual,
    executeNativeOperatorApproval: (
      ...args: Parameters<typeof actual.executeNativeOperatorApproval>
    ) => {
      const result = actual.executeNativeOperatorApproval(...args);
      if (args[0] === "operatorApprovals.resolve" && resultDelivery.loseResult === "native") {
        resultDelivery.loseResult = undefined;
        throw new SqliteWorkerError("synthetic committed result delivery loss", "outcome-unknown");
      }
      return result;
    },
  };
});

let sharedState: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
beforeAll(async () => {
  sharedState = await createOpenClawTestState({ label: "approval-uncertain-settlement" });
});
beforeEach(() => sharedState?.applyEnv());
afterEach(() => {
  resultDelivery.loseResult = undefined;
  resultDelivery.hideReceipt = false;
  resultDelivery.wrapRefusal = false;
  resultDelivery.wrappedRefusal = undefined;
  vi.restoreAllMocks();
});
afterAll(async () => sharedState?.cleanup());

it.each(["resolve", "deny"] as const)(
  "preserves a real %s refusal inside the broker cleanup aggregate",
  async (operation) => {
    const state = expectDefined(sharedState, "shared approval test state");
    const databaseOptions = { env: state.env };
    const persistence = { runtimeEpoch: "aggregate-refusal", databaseOptions };
    const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
      persistence,
      resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    });
    const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence,
    });
    const record = exec.create({ command: "echo retained pending" }, 600_000);
    record.approvalReviewerDeviceIds = ["aggregate-reviewer"];
    const { decision } = await exec.register(record, 600_000);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    const before = getOperatorApproval({ id: record.id, databaseOptions });
    const connection = new AbortController();
    const client = createClient({ deviceId: "aggregate-reviewer" });
    client.connectionSignal = connection.signal;
    const invocation = createApprovalInvocation({
      handlers: createApprovalHandlers({
        execApprovalManager: exec,
        pluginApprovalManager: plugin,
        databaseOptions,
      }),
      method: "approval.resolve",
      client,
      body: {
        id: record.id,
        kind: "exec",
        decision: operation === "resolve" ? "allow-once" : "invalid",
      },
    });
    let transactions = 0;
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "transaction") {
            transactions += 1;
            if (transactions === 1) {
              connection.abort();
            }
          } else if (request.stage === "commit" && transactions === 2) {
            invalidateGatewayDeviceRevocation(invocation.context, "aggregate-reviewer", "operator");
          }
          return admit(request, grant);
        }, attachment),
    );
    resultDelivery.wrapRefusal = true;
    try {
      expect(await invocation.invoke()).toMatchObject({ ok: false });
      expect(transactions).toBe(2);
      expect(resultDelivery.wrappedRefusal).toBeInstanceOf(ApprovalMutationRefusedError);
      expect(getOperatorApproval({ id: record.id, databaseOptions })).toEqual(before);
      expect(settled).toBe(false);
      expect(record.resolvedAtMs).toBeUndefined();
      expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
    } finally {
      await Promise.all([exec.drain(), plugin.drain()]);
    }
  },
);

it.each([false, true])(
  "keeps missing-row settlement with its original owner (replaced: %s)",
  async (replace) => {
    const state = expectDefined(sharedState, "shared approval test state");
    const databaseOptions = { env: state.env };
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    const persistence = { runtimeEpoch: "missing-owner", databaseOptions };
    const exec = new ExecApprovalManager({ persistence });
    const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence,
    });
    const record = exec.create({ command: "echo missing approval" }, 600_000);
    record.approvalReviewerDeviceIds = ["missing-reviewer"];
    const { decision } = await exec.register(record, 600_000);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    vi.spyOn(operatorApprovalStore, "resolveOperatorApproval").mockRejectedValueOnce(
      new SqliteWorkerError("synthetic uncertain original verdict", "outcome-unknown"),
    );
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockRejectedValueOnce(
      new SqliteWorkerError("synthetic original readback unavailable", "unavailable"),
    );
    try {
      await expect(exec.resolveAutoReview(record.id)).rejects.toThrow("verdict remains uncertain");
      if (replace) {
        const original = await stat(databasePath);
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
        const replacement = `${databasePath}.missing-replacement`;
        await copyFile(databasePath, replacement);
        await rename(replacement, databasePath);
        expect((await stat(databasePath)).ino).not.toBe(original.ino);
      }
      deleteDurableApproval(databaseOptions, record.id);
      expect(
        await createApprovalInvocation({
          handlers: createApprovalHandlers({
            execApprovalManager: exec,
            pluginApprovalManager: plugin,
            databaseOptions,
          }),
          method: "approval.get",
          body: { id: record.id },
          client: createClient({ deviceId: "missing-reviewer" }),
        }).invoke(),
      ).toMatchObject({ ok: false });
      if (replace) {
        expect(settled).toBe(false);
        expect(record.resolvedAtMs).toBeUndefined();
      } else {
        await expect(decision).resolves.toBe("deny");
        expect(record.terminalReason).toBe("storage-corrupt");
      }
    } finally {
      await Promise.all([exec.drain(), plugin.drain()]);
    }
  },
);

it.each(["resolve", "deny", "cancel", "expire"] as const)(
  "retains the original uncertain owner before a %s retry",
  async (operation) => {
    const state = expectDefined(sharedState, "shared approval test state");
    const databaseOptions = { env: state.env };
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    const onLifecycle = vi.fn();
    const manager = new ExecApprovalManager({
      persistence: { runtimeEpoch: "retry-owner", databaseOptions },
      onLifecycle,
    });
    const record = manager.create({ command: "echo original owner" }, 600_000);
    const { decision } = await manager.register(record, 600_000);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    vi.spyOn(operatorApprovalStore, "resolveOperatorApproval").mockRejectedValueOnce(
      new SqliteWorkerError("synthetic unconfirmed original verdict", "outcome-unknown"),
    );
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockRejectedValueOnce(
      new SqliteWorkerError("synthetic original readback unavailable", "unavailable"),
    );
    try {
      await expect(manager.resolveAutoReview(record.id)).rejects.toThrow(
        "verdict remains uncertain",
      );
      const before = getOperatorApproval({
        id: record.id,
        nowMs: record.createdAtMs,
        databaseOptions,
      });
      const original = await stat(databasePath);
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      const replacement = `${databasePath}.retry-replacement`;
      await copyFile(databasePath, replacement);
      await rename(replacement, databasePath);
      expect((await stat(databasePath)).ino).not.toBe(original.ino);
      if (operation === "expire") {
        vi.spyOn(Date, "now").mockReturnValue(record.expiresAtMs);
        installTestApprovalClock();
      }
      const retry =
        operation === "resolve"
          ? manager.resolve(record.id, "allow-once")
          : operation === "deny"
            ? manager.forceDenyDetailed(record.id, "malformed-verdict", {
                kind: "device",
                id: "reviewer",
              })
            : operation === "cancel"
              ? manager.forceDenyDetailed(
                  record.id,
                  "run-aborted",
                  { kind: "system", id: null },
                  "cancelled",
                )
              : manager.getSnapshot(record.id);
      const failure = await retry.catch((error: unknown) => error);
      expect(
        getOperatorApproval({ id: record.id, nowMs: record.createdAtMs, databaseOptions }),
      ).toEqual(before);
      expect(settled).toBe(false);
      expect(record.resolvedAtMs).toBeUndefined();
      expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
        0,
      );
      expect(failure).toBeInstanceOf(Error);
      if (operation === "cancel") {
        expect(record.approvalAuthority?.()).toBe(false);
      }
    } finally {
      await manager.drain();
    }
  },
);

it.each(["worker", "native", "missing-receipt"] as const)(
  "uses only actual commit receipts after result loss (%s)",
  async (variant) => {
    const state = expectDefined(sharedState, "shared approval test state");
    const databaseOptions = { env: state.env };
    const persistence = { runtimeEpoch: "receipt-custody", databaseOptions };
    const onLifecycle = vi.fn();
    const manager = new ExecApprovalManager({ persistence, onLifecycle });
    const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence,
    });
    const record = manager.create({ command: "echo received commit" }, 600_000);
    record.approvalReviewerDeviceIds = ["receipt-reviewer"];
    const { decision } = await manager.register(record, 600_000);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    const readback = vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed");
    resultDelivery.loseResult = variant === "native" ? "native" : "worker";
    resultDelivery.hideReceipt = variant === "missing-receipt";
    try {
      await expect(
        manager.resolveAutoReview(
          record.id,
          null,
          undefined,
          variant === "native"
            ? {
                family: "native-compatibility",
                assertCurrent: () => {
                  getOperatorApproval({ id: record.id, databaseOptions });
                },
              }
            : undefined,
        ),
      ).rejects.toThrow("synthetic committed result delivery loss");
      expect(readback).toHaveBeenCalledTimes(1);
      expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
        status: "allowed",
        decision: "allow-once",
      });
      if (variant === "missing-receipt") {
        expect(settled).toBe(false);
        resultDelivery.hideReceipt = false;
        resultDelivery.loseResult = "worker";
        await expect(manager.resolve(record.id, "allow-once")).rejects.toThrow(
          "synthetic committed result delivery loss",
        );
        expect(
          await createApprovalInvocation({
            handlers: createApprovalHandlers({
              execApprovalManager: manager,
              pluginApprovalManager: plugin,
              databaseOptions,
            }),
            method: "approval.get",
            body: { id: record.id },
            client: createClient({ deviceId: "receipt-reviewer" }),
          }).invoke(),
        ).toMatchObject({ ok: true, result: { approval: { status: "allowed" } } });
        expect(settled).toBe(false);
        expect(record.resolutionSource).toBeUndefined();
        expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
          0,
        );
      } else {
        await expect(decision).resolves.toBe("allow-once");
        expect(record.resolutionSource).toBe("auto-review");
        expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
          1,
        );
      }
    } finally {
      await Promise.all([manager.drain(), plugin.drain()]);
    }
  },
);

it.each([
  {
    name: "device after pending readback",
    unavailable: false,
    kind: "device",
    id: "device-winner",
  },
  {
    name: "channel after unavailable readback",
    unavailable: true,
    kind: "channel",
    id: "channel-winner",
  },
  { name: "runtime after pending readback", unavailable: false, kind: "runtime", id: null },
  {
    name: "ambiguous runtime after unavailable readback",
    unavailable: true,
    kind: "runtime",
    id: null,
  },
] as const)("does not attribute an uncertain auto-review to $name", async (variant) => {
  const state = expectDefined(sharedState, "shared approval test state");
  const databaseOptions = { env: state.env };
  const persistence = { runtimeEpoch: "competing-review-custody", databaseOptions };
  const onLifecycle = vi.fn();
  const exec = new ExecApprovalManager({ persistence, onLifecycle });
  const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
    approvalKind: "plugin",
    persistence,
  });
  const record = exec.create({ command: "echo independent winner" }, 600_000);
  record.approvalReviewerDeviceIds = ["competing-reviewer"];
  const { decision } = await exec.register(record, 600_000);
  let settled = false;
  void decision.then(() => {
    settled = true;
  });
  const resolve = operatorApprovalStore.resolveOperatorApproval;
  vi.spyOn(operatorApprovalStore, "resolveOperatorApproval").mockRejectedValueOnce(
    new SqliteWorkerError("synthetic unconfirmed auto-review", "outcome-unknown"),
  );
  if (variant.unavailable) {
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockRejectedValueOnce(
      new SqliteWorkerError("synthetic readback unavailable", "unavailable"),
    );
  }
  try {
    await expect(exec.resolveAutoReview(record.id)).rejects.toThrow(
      variant.unavailable ? "verdict remains uncertain" : "synthetic unconfirmed auto-review",
    );
    expect(settled).toBe(false);
    expect(
      await resolve({
        id: record.id,
        decision: "allow-once",
        resolver: { kind: variant.kind, id: variant.id },
        runtimeEpoch: persistence.runtimeEpoch,
        expectedKind: "exec",
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "resolved" });
    const invocation = createApprovalInvocation({
      handlers: createApprovalHandlers({
        execApprovalManager: exec,
        pluginApprovalManager: plugin,
        databaseOptions,
      }),
      method: "approval.get",
      body: { id: record.id },
      client: createClient({ deviceId: "competing-reviewer" }),
    });
    expect(await invocation.invoke()).toMatchObject({
      ok: true,
      result: { approval: { status: "allowed" } },
    });
    if (variant.kind === "runtime" && variant.unavailable) {
      expect(settled).toBe(false);
      expect(record.resolutionSource).toBeUndefined();
      expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
        0,
      );
    } else {
      await expect(decision).resolves.toBe("allow-once");
      expect(record.resolutionSource).toBe("operator");
      expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
        1,
      );
    }
  } finally {
    await Promise.all([exec.drain(), plugin.drain()]);
  }
});

it.each(["before-readback", "before-local-settlement"] as const)(
  "does not settle an uncertain verdict across database replacement %s",
  async (replacementStage) => {
    const state = expectDefined(sharedState, "shared approval test state");
    const databaseOptions = { env: state.env };
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    const onLifecycle = vi.fn();
    const manager = new ExecApprovalManager({
      persistence: { runtimeEpoch: "replacement-custody", databaseOptions },
      onLifecycle,
    });
    const record = manager.create({ command: "echo original owner" }, 600_000);
    const { decision } = await manager.register(record, 600_000);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    const replaceDatabase = async () => {
      const original = await stat(databasePath);
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      const replacement = `${databasePath}.replacement`;
      await copyFile(databasePath, replacement);
      await rename(replacement, databasePath);
      expect((await stat(databasePath)).ino).not.toBe(original.ino);
    };
    const resolve = operatorApprovalStore.resolveOperatorApproval;
    vi.spyOn(operatorApprovalStore, "resolveOperatorApproval").mockImplementationOnce(
      async (input) => {
        await resolve(input);
        if (replacementStage === "before-readback") {
          await replaceDatabase();
        }
        throw new SqliteWorkerError("synthetic reply lost after real commit", "outcome-unknown");
      },
    );
    if (replacementStage === "before-local-settlement") {
      const readback = approvalRecovery.readUncertainExecApprovalVerdict;
      vi.spyOn(approvalRecovery, "readUncertainExecApprovalVerdict").mockImplementationOnce(
        async (...args) => {
          const result = await readback(...args);
          await replaceDatabase();
          return result;
        },
      );
    }
    try {
      const failure = await manager
        .resolve(record.id, "allow-once")
        .catch((error: unknown) => error);
      expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
        id: record.id,
        runtimeEpoch: "replacement-custody",
        createdAtMs: record.createdAtMs,
        status: "allowed",
        decision: "allow-once",
      });
      expect(settled).toBe(false);
      expect(record.resolvedAtMs).toBeUndefined();
      expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
        0,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toHaveProperty(
        "message",
        "Approval verdict remains uncertain after readback",
      );
    } finally {
      await manager.drain();
    }
  },
);

it.each(
  (["resolve", "deny"] as const).flatMap((operation) =>
    [false, true].map((revoke) => ({ operation, revoke })),
  ),
)(
  "settles a committed $operation after a lost reply (revoked: $revoke)",
  async ({ operation, revoke }) => {
    const state = expectDefined(sharedState, "shared approval test state");
    const databaseOptions = { env: state.env };
    const persistence = { runtimeEpoch: "lost-reply-test", databaseOptions };
    const onLifecycle = vi.fn();
    const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
      persistence,
      resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
      onLifecycle,
    });
    const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence,
    });
    const record = exec.create(
      { command: "echo committed" },
      600_000,
      `lost-reply-${operation}-${revoke}`,
    );
    const deviceId = `lost-reply-reviewer-${operation}-${revoke}`;
    record.approvalReviewerDeviceIds = [deviceId];
    const { decision } = await exec.register(record, 600_000);
    let settled: string | null | undefined;
    void decision.then((value) => {
      settled = value;
    });
    const handlers = createApprovalHandlers({
      execApprovalManager: exec,
      pluginApprovalManager: plugin,
      databaseOptions,
    });
    const invocation = createApprovalInvocation({
      handlers,
      method: "approval.resolve",
      client: createClient({ deviceId }),
      body: {
        id: record.id,
        kind: "exec",
        decision: operation === "resolve" ? "allow-once" : "invalid",
      },
    });
    const loseReply = async (write: () => Promise<unknown>) => {
      await write();
      if (revoke) {
        invalidateGatewayDeviceRevocation(invocation.context, deviceId, "operator");
      }
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
    try {
      expect(await invocation.invoke()).toMatchObject({ ok: false });
      const expectedDecision = operation === "resolve" ? "allow-once" : "deny";
      expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
        status: operation === "resolve" ? "allowed" : "denied",
        decision: expectedDecision,
      });
      expect(settled).toBe(expectedDecision);
      expect(record.decision).toBe(expectedDecision);
      expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(
        1,
      );
      expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
    } finally {
      await Promise.all([exec.drain(), plugin.drain()]);
    }
  },
);

it.each([
  "auto-review",
  "readback-unavailable",
  "target-changed",
  "auto-review-readback-unavailable",
  "auto-review-retry",
  "auto-review-not-committed",
  "auto-review-not-committed-readback-unavailable",
] as const)("preserves uncertain verdict custody for %s", async (variant) => {
  const state = expectDefined(sharedState, "shared approval test state");
  const databaseOptions = { env: state.env };
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const autoReview = variant.startsWith("auto-review");
  const uncommitted = variant.startsWith("auto-review-not-committed");
  const unavailable = variant.endsWith("readback-unavailable") || variant === "auto-review-retry";
  const persistence = {
    runtimeEpoch: "uncertain-custody-test",
    ...(variant === "target-changed" ? {} : { databaseOptions }),
  };
  const onLifecycle = vi.fn();
  const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
    persistence,
    resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    onLifecycle,
  });
  const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
    approvalKind: "plugin",
    persistence,
  });
  const record = exec.create({ command: "echo committed" }, 600_000, `uncertain-${variant}`);
  record.approvalReviewerDeviceIds = ["uncertain-reviewer"];
  const { decision } = await exec.register(record, 600_000);
  let settled: string | null | undefined;
  void decision.then((value) => {
    settled = value;
  });
  const resolve = operatorApprovalStore.resolveOperatorApproval;
  vi.spyOn(operatorApprovalStore, "resolveOperatorApproval").mockImplementationOnce(
    async (input) => {
      if (!uncommitted) {
        await resolve(input);
      }
      if (variant === "target-changed") {
        process.env.OPENCLAW_STATE_DIR = `${expectDefined(state.env.OPENCLAW_STATE_DIR, "test state directory")}/moved`;
      }
      if (unavailable) {
        vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockRejectedValueOnce(
          new SqliteWorkerError("synthetic readback unavailable", "unavailable"),
        );
      }
      throw new SqliteWorkerError("synthetic reply lost after real commit", "outcome-unknown");
    },
  );
  try {
    await expect(
      autoReview
        ? exec.resolveAutoReview(record.id, "synthetic-runtime")
        : exec.resolve(record.id, "allow-once"),
    ).rejects.toThrow(unavailable ? "verdict remains uncertain" : "synthetic reply lost");
    expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject(
      uncommitted
        ? { status: "pending", decision: null }
        : { status: "allowed", decision: "allow-once" },
    );
    if (uncommitted) {
      expect(settled).toBeUndefined();
      expect(await exec.resolve(record.id, "allow-once", "confirmed-operator")).toBe(true);
      expect(settled).toBe("allow-once");
      expect(record.resolutionSource).toBe("operator");
    } else if (!unavailable) {
      expect(settled).toBe("allow-once");
      expect(record.resolutionSource).toBe(autoReview ? "auto-review" : "operator");
    } else {
      expect(settled).toBeUndefined();
      expect(record.resolvedAtMs).toBeUndefined();
      const handlers = createApprovalHandlers({
        execApprovalManager: exec,
        pluginApprovalManager: plugin,
        databaseOptions,
      });
      if (variant === "auto-review-retry") {
        expect(await exec.resolve(record.id, "allow-once", "operator-retry")).toBe(false);
      } else {
        expect(
          await createApprovalInvocation({
            handlers,
            method: "approval.get",
            body: { id: record.id },
            client: createClient({ deviceId: "uncertain-reviewer" }),
          }).invoke(),
        ).toMatchObject({ ok: true, result: { approval: { status: "allowed" } } });
      }
      expect(settled).toBe("allow-once");
      expect(record.resolutionSource).toBe(autoReview ? "auto-review" : "operator");
    }
    expect(onLifecycle.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(1);
  } finally {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await Promise.all([exec.drain(), plugin.drain()]);
  }
});

it.each([false, true])(
  "retains no-route ask fallback after reply loss (readback unavailable: %s)",
  async (unavailable) => {
    const state = expectDefined(sharedState, "shared approval test state");
    const databaseOptions = { env: state.env };
    const persistence = { runtimeEpoch: "no-route-recovery", databaseOptions };
    const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
      persistence,
      resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    });
    const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence,
    });
    const record = exec.create(
      { command: "echo no route" },
      600_000,
      `no-route-recovery-${unavailable}`,
    );
    record.approvalReviewerDeviceIds = ["no-route-reviewer"];
    const { decision } = await exec.register(record, 600_000);
    let settled: string | null | undefined;
    void decision.then((value) => {
      settled = value;
    });
    const deny = operatorApprovalStore.forceDenyOperatorApproval;
    vi.spyOn(operatorApprovalStore, "forceDenyOperatorApproval").mockImplementationOnce(
      async (input) => {
        await deny(input);
        if (unavailable) {
          vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockRejectedValueOnce(
            new SqliteWorkerError("synthetic readback unavailable", "unavailable"),
          );
        }
        throw new SqliteWorkerError("synthetic no-route reply lost", "outcome-unknown");
      },
    );
    try {
      await expect(exec.expire(record.id, "no-approval-route")).rejects.toThrow();
      expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
        status: "denied",
        decision: "deny",
        terminalReason: "no-route",
      });
      if (unavailable) {
        expect(settled).toBeUndefined();
        const handlers = createApprovalHandlers({
          execApprovalManager: exec,
          pluginApprovalManager: plugin,
          databaseOptions,
        });
        expect(
          await createApprovalInvocation({
            handlers,
            method: "approval.get",
            body: { id: record.id },
            client: createClient({ deviceId: "no-route-reviewer" }),
          }).invoke(),
        ).toMatchObject({ ok: true, result: { approval: { status: "denied" } } });
      }
      expect(settled).toBeNull();
      expect(record.decision).toBeUndefined();
      expect(exec.consumeAskFallback(record.id)).toBe(true);
      expect(exec.consumeAskFallback(record.id)).toBe(false);
    } finally {
      await Promise.all([exec.drain(), plugin.drain()]);
    }
  },
);
