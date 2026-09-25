import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { createCollectorLaunchCallbacks } from "../agents/subagents/spawn/subagent-spawn-collector.js";
import {
  activateSwarmRun,
  closeSwarmScheduler,
  holdQueuedSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

const { parentKey, createQueuedReservation, requestContext, operatorClient } =
  useQueuedCollectorFixture();

it.each([
  "success",
  "rollback",
  "rollback-undefined",
  "attachments",
  "session",
  "disposal",
  "retired",
  "retired-disposal",
  "settlement",
  "settlement-undefined",
  "settlement-disposal",
] as const)(
  "requires completed revoked collector cleanup before Stop certifies cancellation: %s",
  async (failure) => {
    const { entry } = await createQueuedReservation("revoked");
    const producer = expectDefined(holdQueuedSwarmRun(entry.runId), "preparation hold");
    const source = new AbortController();
    const cleanupEntered = createDeferred();
    const cleanupGate = createDeferred();
    const rollbackFailure =
      failure === "rollback-undefined" ? undefined : new Error("prepared context rollback failed");
    const failedRollback = failure.startsWith("rollback");
    const settlementFailure =
      failure === "settlement-undefined"
        ? undefined
        : new Error("queued failure persistence failed");
    const disposalFailure = new PluginRuntimeCloseRetainedError(new Error("native close failed"));
    const nativeFailure =
      failure === "disposal" || failure === "retired-disposal" || failure === "settlement-disposal";
    const retired = failure === "retired" || failure === "retired-disposal";
    const failedSettlement = failure.startsWith("settlement");
    const skipsCleanup = retired || failedSettlement;
    const disposeResource = vi.fn(async () => {
      if (nativeFailure) {
        throw disposalFailure;
      }
    });
    let disposal: Promise<void> | undefined;
    const dispose = () => (disposal ??= disposeResource());
    const rollback = vi.fn(async () => {
      try {
        if (failedRollback) {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve JavaScript cleanup rejection values, including undefined.
          await Promise.reject(rollbackFailure);
        }
      } finally {
        await dispose();
      }
    });
    const settleFailedLaunch = vi.fn(async () => {
      if (failedSettlement) {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve JavaScript settlement rejection values, including undefined.
        await Promise.reject(settlementFailure);
      }
    });
    const cleanupFailedSpawn = vi.fn(async () => {
      cleanupEntered.resolve();
      await cleanupGate.promise;
      return {
        attachmentsRemoved: failure !== "attachments",
        sessionDeleted: failure !== "session",
      };
    });
    const launchChildRun = vi.fn(async () => ({ response: { runId: entry.runId } }));
    const callbacks = createCollectorLaunchCallbacks({
      childRunId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: parentKey,
      operatorAuthority: createAdmittedRunOperatorAuthority({
        profileId: "synthetic-operator",
        scopes: ["operator.write"],
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
      }),
      registrationScope: {
        canLaunch: () => false,
        canAcceptLaunch: () => false,
        canCleanupSession: () => !retired,
        canRetireReservation: () => false,
        waitForClaim: () => undefined,
        settleFailedLaunch,
      },
      preparation: { rollback, dispose },
      provisionalSessionIdentity: {},
      launchChildRun,
      recordParticipant: vi.fn(),
      emitSpawnLifecycleHooks: async () => {},
      cleanupFailedSpawn,
    });
    // Abort after Stop captures the same reservation, before its cleanup callback runs.
    activateSwarmRun({ groupId: entry.groupId!, runId: entry.runId, ...callbacks });
    const context = requestContext();
    expectDefined(
      context.chatAbortControllers.get("parent-turn"),
      "parent execution",
    ).controller.signal.addEventListener("abort", () => source.abort(new Error("source revoked")));
    const respond = vi.fn();
    const stopping = Promise.resolve(
      expectDefined(
        sessionAbortHandlers["sessions.abort"],
        "Stop handler",
      )({
        req: { type: "req", id: "revoked-queued-stop", method: "sessions.abort" },
        params: { key: parentKey, runId: "parent-turn", agentId: "main" },
        client: operatorClient(),
        isWebchatConnect: () => false,
        context,
        respond,
      }),
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      if (!skipsCleanup) {
        await cleanupEntered.promise;
        expect(respond).not.toHaveBeenCalled();
        expect(
          loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.lastRunId,
        ).toBeUndefined();
      }
      cleanupGate.resolve();
      const stopResult = await stopping;
      const stored = expectDefined(
        loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry,
        "cancelled session",
      );
      expect(launchChildRun).not.toHaveBeenCalled();
      expect(settleFailedLaunch).toHaveBeenCalledOnce();
      expect(cleanupFailedSpawn).toHaveBeenCalledTimes(skipsCleanup ? 0 : 1);
      expect(rollback).toHaveBeenCalledTimes(skipsCleanup ? 0 : 1);
      expect(disposeResource).toHaveBeenCalledOnce();
      if (failure === "success") {
        expect(stopResult).toEqual({ ok: true });
        expect(respond).toHaveBeenCalledOnce();
        await expect(producer.settleCancellation()).resolves.toBe(true);
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(stored.lastRunId).toBe(entry.runId);
      } else {
        expect(stored.lastRunId).toBeUndefined();
        expect(respond).not.toHaveBeenCalled();
        const expectedError = failedSettlement
          ? nativeFailure
            ? expect.objectContaining({ errors: [settlementFailure, disposalFailure] })
            : settlementFailure
          : nativeFailure
            ? disposalFailure
            : failedRollback
              ? rollbackFailure
              : expect.any(Error);
        expect(stopResult).toEqual({ ok: false, error: expectedError });
        await expect(producer.settleCancellation()).rejects.toEqual(expectedError);
        await expect(closeSwarmScheduler()).rejects.toMatchObject({ errors: [expectedError] });
        if (nativeFailure) {
          await expect(closeSwarmScheduler()).rejects.toMatchObject({ errors: [expectedError] });
        }
      }
    } finally {
      cleanupGate.resolve();
      await stopping;
      await producer.release();
      // Synthetic retained-close failures intentionally remain owned until fixture teardown.
      await closeSwarmScheduler().catch(() => {});
      schedulerTesting.reset();
    }
  },
);
