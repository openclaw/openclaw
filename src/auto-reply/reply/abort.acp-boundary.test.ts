import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
/** Channel Stop cancels native and bound ACP controller turns independently of either drain. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "../../gateway/server-methods/chat.abort-registry.test-support.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { testing as acpTesting, getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  isSessionControllerWorkActive,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { captureChannelSessionStop } from "./abort-operation.js";
import { tryFastAbortFromMessage } from "./abort.js";
import { buildTestCtx } from "./test-ctx.js";

const fixture = useChatAbortRegistryFixture();

async function beforeSettlement<T>(gate: Promise<T>, operation: Promise<unknown>) {
  return Promise.race([
    gate,
    operation.then(() => {
      throw new Error("Operation settled before its cancellation gate");
    }),
  ]);
}

it.each(["idle", "active", "native failure"])(
  "native and bound ACP cancellation initiate before either drain (%s)",
  async (scenario) => {
    const active = scenario !== "idle";
    const nativeFailure = scenario === "native failure";
    const nativeError = new Error("native cancellation failed");
    const backendError = new Error("backend cancellation failed");
    const expectBackendCleanupFailure = (error: unknown): AcpRuntimeError => {
      if (!(error instanceof AggregateError)) {
        throw new Error("Expected a session source cleanup failure", { cause: error });
      }
      expect(error.message).toBe("Session source cleanup failed");
      expect(error.errors).toHaveLength(1);
      const runtimeError: unknown = error.errors[0];
      if (!(runtimeError instanceof AcpRuntimeError)) {
        throw new Error("Expected the ACP runtime cancellation failure", { cause: runtimeError });
      }
      expect(runtimeError.code).toBe("ACP_TURN_FAILED");
      expect(runtimeError.message).toBe(backendError.message);
      expect(runtimeError.cause).toBe(backendError);
      return runtimeError;
    };
    const sourceKey = "agent:main:stop-test:direct:room";
    const acpKey = "agent:main:acp:bound-stop";
    const runningKey = "agent:main:subagent:running";
    const queuedKey = "agent:main:subagent:queued";
    const children = [
      ["running", runningKey],
      ["queued", queuedKey],
    ] as const;
    for (const [runId, sessionKey] of [
      ["source", sourceKey],
      ["acp", acpKey],
      ...children,
    ] as const) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${runId}-session`,
      });
    }
    const cfg = getRuntimeConfig();
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    const registry = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "stop-test",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "stop-test" }),
            conversationBindings: { supportsCurrentConversationBinding: true },
          },
        },
      ]),
    );
    const binding = await getSessionBindingService().bind({
      targetSessionKey: acpKey,
      targetKind: "session",
      conversation: { channel: "stop-test", accountId: "default", conversationId: "room" },
      placement: "current",
    });
    const entered = createDeferred();
    const proceed = createDeferred();
    const turnStarted = createDeferred<AbortSignal>();
    const finishTurn = createDeferred();
    const nativeInterrupted = createDeferred();
    const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {
      entered.resolve();
      await proceed.promise;
      if (active) {
        throw backendError;
      }
    });
    const settleCancelRpc = async () => {
      expect(cancel).toHaveBeenCalledOnce();
      const result = cancel.mock.results[0];
      if (result?.type !== "return") {
        throw new Error("ACP cancellation did not return its runtime promise");
      }
      await Promise.allSettled([result.value]);
      await nextTurn();
    };
    registerAcpRuntimeBackend({
      id: "stop-test",
      runtime: {
        ensureSession: async ({ sessionKey }) => ({
          sessionKey,
          backend: "stop-test",
          runtimeSessionName: "mock-runtime",
        }),
        async *runTurn({ signal }) {
          if (!signal) {
            throw new Error("ACP manager did not provide its active turn signal");
          }
          turnStarted.resolve(signal);
          await finishTurn.promise;
          yield { type: "done", status: "cancelled" };
        },
        cancel,
        close: async () => {},
      },
    });
    acpTesting.resetAcpSessionManagerForTests();
    const manager = getAcpSessionManager();
    const syncRead = vi.spyOn(manager, "resolveSession").mockImplementation(() => {
      throw new Error("Stop must resolve ACP metadata through the worker");
    });
    const native = createReplyOperation({
      sessionKey: sourceKey,
      sessionId: "source-session",
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey: sourceKey,
        incarnation: "source-session",
        agentId: "main",
      }),
      resetTriggered: false,
    });
    native.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      cancel: () => {
        queueMicrotask(() => native.complete());
        releaseSwarmRun("capacity");
        if (nativeFailure) {
          throw nativeError;
        }
      },
    });
    const runningAbort = vi.fn(() => {
      queueMicrotask(() => clearActiveEmbeddedRun("running-session", handle, runningKey));
    });
    const handle = createEmbeddedRunHandle({ runId: "running", abort: runningAbort });
    setActiveEmbeddedRun("running-session", handle, runningKey);
    const selectedDispatch = vi.fn(async () => {});
    const survivorDispatch = vi.fn(async () => {});
    let pending: ReturnType<typeof tryFastAbortFromMessage> | undefined;
    let childAdmission: SessionEffectRef | undefined;
    const preparedAdmission = prepareAgentRunAdmission({
      cfg,
      operationalRunInstance: createOperationalRunInstanceRef("acp-steer"),
      facts: {
        runId: "acp-steer",
        agentId: "main",
        ingress: { kind: "acp", boundary: "acp.command.steer", state: "absent" },
      },
    });
    let turn: Promise<void> | undefined;
    let acpSignal: AbortSignal | undefined;
    let stopSettled = false;
    const nativeTerminal = createDeferred();
    const stopObservingNative = subscribeSubagentRunChanges("persistence", () => {
      if (
        children.every(([runId, key]) => {
          const entry = subagentRuns.get(runId);
          return entry?.childSessionKey === key && entry.endedReason === "subagent-killed";
        })
      ) {
        nativeTerminal.resolve();
      }
    });
    try {
      await manager.initializeSession({
        cfg,
        sessionKey: acpKey,
        agent: "main",
        mode: "persistent",
        backendId: "stop-test",
      });
      if (active) {
        const admittedRunContext = await preparedAdmission.admit("acp");
        // Match /acp steer: the manager owns the only cancellation signal.
        turn = manager
          .runTurn({
            cfg,
            admittedRunContext,
            sessionKey: acpKey,
            requestId: "acp-steer",
            mode: "steer",
            provenance: "agent",
            text: "keep working",
          })
          .finally(() => preparedAdmission.close());
        acpSignal = await beforeSettlement(turnStarted.promise, turn);
        expect(acpSignal.aborted).toBe(false);
        expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
        childAdmission = await beginSessionEffect({
          scope: storePath,
          identities: [runningKey, "running-session"],
          run: {
            runId: "running",
            sessionKey: runningKey,
            sessionId: "running-session",
            agentId: "main",
          },
          assertAllowed: () => {},
          onInterrupt: () => nativeInterrupted.resolve(),
        });
      }
      for (const [runId, childSessionKey] of children) {
        await registerSubagentRun({
          runId,
          childSessionKey,
          childAgentId: "main",
          sessionEntry: loadExactSessionEntryReadOnly({ storePath, sessionKey: childSessionKey })
            ?.entry,
          requesterSessionKey: sourceKey,
          requesterAgentId: "main",
          requesterDisplayKey: sourceKey,
          task: runId,
          cleanup: "keep",
          collect: true,
          queued: runId === "queued",
          expectsCompletionMessage: false,
        });
      }
      for (const [runId, start] of [
        ["queued", selectedDispatch],
        ["survivor", survivorDispatch],
      ] as const) {
        enqueueSwarmRun({
          groupId: "bound-acp",
          runId,
          maxConcurrent: 1,
          activeRunIds: ["capacity"],
          start,
          onStartFailure: () => true,
        });
      }
      const retainedCleanup = captureChannelSessionStop({
        key: acpKey,
        sessionId: "acp-session",
        storePath,
        agentId: "main",
      }).controller.settled.then(
        () => undefined,
        (error: unknown) => error,
      );
      pending = tryFastAbortFromMessage({
        cfg,
        ctx: buildTestCtx({
          SessionKey: sourceKey,
          CommandBody: "/stop",
          RawBody: "/stop",
          CommandAuthorized: true,
          Provider: "stop-test",
          Surface: "stop-test",
          From: "stop-test:room",
          To: "stop-test:room",
          MessageSid: "77",
          Timestamp: 1234567890000,
        }),
      }).finally(() => {
        stopSettled = true;
      });
      const outcome = pending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      if (active) {
        if (!nativeFailure) {
          await nativeInterrupted.promise;
          expect(native.abortSignal.aborted).toBe(true);
          expect(isSessionControllerWorkActive(storePath, [runningKey, "running-session"])).toBe(
            true,
          );
        }
        await beforeSettlement(entered.promise, outcome);
        if (nativeFailure) {
          expect(native.abortSignal.aborted).toBe(true);
        }
        expect(acpSignal?.aborted).toBe(true);
        expect(stopSettled).toBe(false);
        if (!nativeFailure) {
          expect(cancel).toHaveBeenCalledOnce();
          expect(selectedDispatch).not.toHaveBeenCalled();
        }
        proceed.resolve();
        await settleCancelRpc();
        expect(stopSettled).toBe(false);
        childAdmission?.release();
      }
      if (nativeFailure) {
        expect(await outcome).toEqual({ error: nativeError });
        expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
        finishTurn.resolve();
        const runtimeError = expectBackendCleanupFailure(await retainedCleanup);
        await expect(turn).rejects.toBe(runtimeError);
        expect(cancel).toHaveBeenCalledOnce();
        return;
      }
      await vi.waitFor(() => expect(native.abortSignal.aborted).toBe(true));
      // Native terminal publication is independent of the still-held ACP completion.
      await vi.waitFor(() => expect(runningAbort).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(survivorDispatch).toHaveBeenCalledOnce());
      expect(selectedDispatch).not.toHaveBeenCalled();
      await nativeTerminal.promise;
      for (const key of [runningKey, queuedKey]) {
        expect((await getSubagentRunByChildSessionKey(key))?.endedReason).toBe("subagent-killed");
      }
      await vi.waitFor(() =>
        expect(loadExactSessionEntryReadOnly({ sessionKey: sourceKey })?.entry).toMatchObject({
          abortedLastRun: true,
          abortCutoffMessageSid: "77",
          abortCutoffTimestamp: 1234567890000,
        }),
      );
      proceed.resolve();
      if (active) {
        await settleCancelRpc();
      }
      expect(await pending).toEqual({
        handled: true,
        aborted: true,
        stoppedSubagents: 2,
        failedSubagents: 0,
      });
      if (active) {
        expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
      }
      finishTurn.resolve();
      if (active) {
        const runtimeError = expectBackendCleanupFailure(await retainedCleanup);
        await expect(turn).rejects.toBe(runtimeError);
      } else {
        expect(await retainedCleanup).toBeUndefined();
        await turn;
      }
      // An idle backend keeps its process; only /acp cancel and reset send it ACP cancel.
      expect(cancel).toHaveBeenCalledTimes(active ? 1 : 0);
      if (active) {
        expect(cancel).toHaveBeenCalledWith(
          expect.objectContaining({ handle: expect.objectContaining({ sessionKey: acpKey }) }),
        );
      }
      expect(readAcpSessionEntry({ cfg, sessionKey: acpKey })?.acp?.state).toBe("idle");
    } finally {
      syncRead.mockRestore();
      stopObservingNative();
      childAdmission?.release();
      proceed.resolve();
      finishTurn.resolve();
      await pending?.catch(() => undefined);
      await turn?.catch(() => undefined);
      preparedAdmission.close();
      native.complete();
      await native.ownerSettlement;
      clearActiveEmbeddedRun("running-session", handle, runningKey);
      releaseSwarmRun("capacity");
      releaseSwarmRun("queued");
      releaseSwarmRun("survivor");
      await disposeAcpSessionManagerInstance(manager, "test-cleanup");
      acpTesting.resetAcpSessionManagerForTests();
      unregisterAcpRuntimeBackend("stop-test");
      await getSessionBindingService().unbind({
        bindingId: binding.bindingId,
        reason: "test-cleanup",
      });
      restoreActivePluginRegistrySnapshot(registry);
    }
  },
);
