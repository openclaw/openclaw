import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as preparedModelRuntime from "../agents/prepared-model-runtime.js";
import * as registryMemory from "../agents/subagents/registry/subagent-registry-memory.js";
import { isSubagentRunQueued } from "../agents/subagents/registry/subagent-registry-read.js";
import * as subagentRegistry from "../agents/subagents/registry/subagent-registry.js";
import { testing as spawnTesting } from "../agents/subagents/spawn/subagent-spawn.test-support.js";
import { closeSwarmScheduler } from "../agents/subagents/swarm/swarm-scheduler.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import {
  isRpcSourceExecuting,
  requestRpcSourceCancellation,
} from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { unwrapGatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";
import { agentRunHandler } from "./server-methods/agent-run-handler.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { sessionDeleteHandlers } from "./server-methods/sessions-delete.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import type { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";

const { requestContext, requestOptions, spawnCollector, expectChanged, gateRowPreparation } =
  useQueuedCollectorFixture();

it.each([
  [false, false],
  [true, false],
  [false, true],
])(
  "joins real preaccept cleanup independently of display preparation (exact=%s, publicationFailure=%s)",
  async (exact, publicationFailure) => {
    const context = requestContext();
    const entered = createDeferred();
    const dispatched = createDeferred();
    const killWriteEntered = createDeferred();
    const releaseKillWrite = createDeferred();
    const cleanupWaiting = createDeferred();
    const order: string[] = [];
    let nativeRunId: string | undefined;
    let stopping: Promise<void> | undefined;
    const agentResponse = vi.fn();
    const registration = vi.spyOn(subagentRegistry, "startQueuedSubagentRun");
    const waitForPublication = registryMemory.waitForSubagentRetirementPublication;
    const publicationWait = vi
      .spyOn(registryMemory, "waitForSubagentRetirementPublication")
      .mockImplementation((entry) => {
        const pending = waitForPublication(entry);
        if (entry.runId === nativeRunId && pending) {
          cleanupWaiting.resolve();
        }
        return pending;
      });
    let holdNotices = false;
    const markTerminated = subagentRegistry.markSubagentRunTerminated;
    const killGate = vi
      .spyOn(subagentRegistry, "markSubagentRunTerminated")
      .mockImplementation(async (params) => {
        if (params.runId === nativeRunId) {
          holdNotices = true;
          killWriteEntered.resolve();
          await releaseKillWrite.promise;
        }
        return markTerminated(params);
      });
    const displayGate = gateRowPreparation(
      context,
      () => holdNotices,
      publicationFailure ? new Error("publication preparation failed") : undefined,
    );
    const runtimeGate = vi
      .spyOn(preparedModelRuntime, "loadPublishedGatewayReplyDispatchRuntime")
      .mockImplementation(async ({ abortSignal }) => {
        const signal = expectDefined(abortSignal, "native admission abort signal");
        signal.throwIfAborted();
        entered.resolve();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error("Native admission aborted"));
            },
            { once: true },
          );
        });
      });
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
        options?: Parameters<typeof dispatchGatewayMethodInProcess>[2],
      ) => {
        const respond = method === "agent" ? agentResponse : vi.fn();
        const request = {
          req: { type: "req" as const, id: "native-preaccept", method },
          params,
          respond,
          context,
          sessionMutationCommitGuard: options?.sessionMutationCommitGuard,
          client: createSyntheticPluginRuntimeClient({
            agentRunTracking: options?.agentRunTracking,
            scopes: options?.syntheticScopes,
          }),
          isWebchatConnect: () => false,
        };
        if (method === "agent") {
          nativeRunId = String(params.idempotencyKey);
          try {
            await agentRunHandler!(request);
          } finally {
            dispatched.resolve();
          }
        } else if (method === "chat.abort") {
          await handleChatAbortRequest(request);
        } else if (method === "sessions.delete") {
          order.push("deleting");
          await expectDefined(sessionDeleteHandlers["sessions.delete"], "delete handler")(request);
          order.push("deleted");
        } else {
          throw new Error(`Unexpected native cleanup method ${method}`);
        }
        const [ok, payload, error] = respond.mock.calls[0] ?? [];
        return unwrapGatewayMethodDispatchResponse(method, { ok, payload, error }) as T;
      },
    });
    try {
      const spawned = await spawnCollector("Pending native collector");
      expect(spawned.status).toBe("accepted");
      await Promise.race([
        entered.promise,
        dispatched.promise.then(() => {
          throw new Error(
            `Native admission ended before runtime gate: ${JSON.stringify(agentResponse.mock.calls)}`,
          );
        }),
      ]);
      const entry = expectDefined(registryMemory.subagentRuns.get(spawned.runId!), "collector");
      const admission = expectDefined(rpcSourceTesting.get(entry.runId), "controller");
      expect(admission.adapter.kind).toBe("agent");
      expect(isRpcSourceExecuting(admission)).toBe(false);
      expect(getAgentRunContext(entry.runId)).toBeDefined();
      expect(isSubagentRunQueued(entry)).toBe(true);
      const target = expectDefined(admission.input.target, "native physical session target");
      const visibleStatus = () =>
        resolveVisibleActiveSessionRunState({
          storePath: target.storeScope,
          agentId: target.agentId,
          sessionId: target.incarnation,
          requestedKey: entry.childSessionKey,
          canonicalKey: entry.childSessionKey,
          resolveGatewayContext: context.resolveGatewayContext,
        }).status;
      expect(visibleStatus()).toBeUndefined();
      const releaseCapacityWait = registerAgentRunCapacityWait(
        entry.runId,
        getAgentRunLifecycleGeneration(),
      );
      try {
        expect(visibleStatus()).toBe("queued");
      } finally {
        releaseCapacityWait?.();
      }
      expect(entry.execution.startedAt).toBeUndefined();
      const options = requestOptions(context, "sessions.abort", {
        key: entry.childSessionKey,
        ...(exact ? { runId: entry.runId } : { clearQueued: true }),
      });
      const { respond } = options;
      stopping = Promise.resolve(sessionAbortHandlers["sessions.abort"]!(options));
      await Promise.race([
        Promise.all([dispatched.promise, killWriteEntered.promise, cleanupWaiting.promise]),
        stopping.then(() => {
          throw new Error(
            `Stop settled before its kill write: ${JSON.stringify(respond.mock.calls)}`,
          );
        }),
      ]);
      expect(order).toEqual([]);
      expect(registration).toHaveBeenCalledOnce();
      await expect(registration.mock.results[0]?.value).resolves.toBe(false);
      const sessionEntry = async () =>
        (await loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey)).entry;
      expect(await sessionEntry()).toBeDefined();
      const interrupted = expectDefined(
        registryMemory.getCurrentSubagentRunOwner(registryMemory.subagentRuns, entry),
        "collector before publication",
      );
      expect(interrupted.execution.startedAt).toBeUndefined();
      releaseKillWrite.resolve();
      await stopping;
      await dispatched.promise;
      // This unadopted launch still owns its provisional session; join its real cleanup.
      await closeSwarmScheduler();
      const stopped = expectDefined(
        registryMemory.getCurrentSubagentRunOwner(registryMemory.subagentRuns, entry),
        "collector after cleanup",
      );
      expect(stopped.collectorCompletion?.status).toBe("killed");
      expect(respond).toHaveBeenCalledOnce();
      expect
        .soft(respond.mock.calls[0]?.slice(0, 2), JSON.stringify(respond.mock.calls[0]?.[2]))
        .toEqual([true, { ok: true, status: "aborted", abortedRunId: entry.runId }]);
      expect.soft(context.chatRunState.hasAbortMarker(entry.runId)).toBe(true);
      expect.soft(admission.adapter.abortStopReason).toBe("rpc");
      expect.soft(entry.execution.startedAt).toBeUndefined();
      expect.soft(entry.sessionStartedAt).toBeUndefined();
      expect(rpcSourceTesting.has(entry.runId)).toBe(false);
      expect(order).toContain("deleted");
      expect(await sessionEntry()).toBeUndefined();
      await displayGate.entered.promise;
      expectChanged(context, { reason: "delete" });
      expect(context.broadcastToConnIds).not.toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: entry.childSessionKey, reason: "abort" }),
        expect.anything(),
        expect.anything(),
      );
      displayGate.release.resolve();
      await flushPendingSessionsChangedEvents(context);
      expectChanged(
        context,
        publicationFailure
          ? { reason: "update" }
          : { sessionKey: entry.childSessionKey, reason: "abort" },
      );
    } finally {
      releaseKillWrite.resolve();
      displayGate.release.resolve();
      if (nativeRunId) {
        const source = rpcSourceTesting.get(nativeRunId);
        if (source) {
          requestRpcSourceCancellation(source);
        }
        await dispatched.promise;
        clearAgentRunContext(nativeRunId);
      }
      await stopping;
      await flushPendingSessionsChangedEvents(context);
      for (const spy of [killGate, displayGate.spy, runtimeGate, registration, publicationWait]) {
        spy.mockRestore();
      }
    }
  },
);
