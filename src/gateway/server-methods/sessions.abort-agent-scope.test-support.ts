import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun as registerNativeRun,
  detachActiveEmbeddedRun as clearNativeRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { createActiveRun as createAbortRun } from "./chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

export function createActiveRun(
  sessionKey: string,
  params: { agentId?: string; sessionId?: string } = {},
) {
  const ref = createAbortRun(sessionKey, {
    sessionId: "sess-active",
    storeScope: fixtureStorePath(params.agentId ?? sessionKey.split(":")[1]),
    ...params,
  });
  markReplyOperationExecutionStarted(
    expectDefined(ref.input.claim?.operation, "active fixture operation"),
  );
  ref.adapter.kind = "chat-send";
  return ref;
}

type ActiveRun = ReturnType<typeof createActiveRun>;
type LegacyTestAgentConfig = { id: string; default?: boolean };

export function createContext(
  options: {
    activeRuns?: ReadonlyArray<readonly [string, ActiveRun]>;
    agents?: LegacyTestAgentConfig[];
    globalScope?: boolean;
    extra?: Partial<GatewayRequestContext>;
  } = {},
): GatewayRequestContext {
  const cfg = createCanonicalAgentConfigFixture({
    agents: { list: options.agents ?? [{ id: "main", default: true }, { id: "work" }] },
    ...(options.globalScope ? { session: { scope: "global" as const } } : {}),
  }).config;
  rpcSourceTesting.reset(options.activeRuns);
  return {
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set(),
    getRuntimeConfig: () => cfg,
    logGateway: { info: () => {}, warn: () => {} },
    ...options.extra,
  } as unknown as GatewayRequestContext;
}

export function createBetaRunContext(activeRun: ActiveRun): GatewayRequestContext {
  return createContext({
    activeRuns: [["run-beta", activeRun]],
    agents: [{ id: "main", default: true }, { id: "beta" }],
  });
}

export function createGlobalWorkRunContext(activeRun: ActiveRun): GatewayRequestContext {
  return createContext({
    activeRuns: [["run-global", activeRun]],
    globalScope: true,
  });
}

export function fixtureStorePath(agentId = "main") {
  return "/synthetic/agent-scope/" + agentId + "/sessions.db";
}

function finishProducer(finished: ReturnType<typeof createDeferred<void>>, cleanup: () => void) {
  const producer = finished.promise.finally(cleanup);
  const finish = () => finished.resolve();
  onTestFinished(async () => {
    finish();
    await producer;
  });
  return finish;
}

export function createPhysicalOperation(
  params: Parameters<typeof createReplyOperation>[0] & { sessionKey: string },
) {
  const operation = createReplyOperation({
    ...params,
    target: captureSessionTarget({
      storeScope: fixtureStorePath(params.agentId ?? params.sessionKey?.split(":")[1]),
      sessionKey: params.sessionKey,
      incarnation: params.sessionId,
      agentId: params.agentId,
    }),
  });
  const finish = createDeferred();
  operation.abortSignal.addEventListener("abort", () => finish.resolve(), { once: true });
  finishProducer(finish, () => operation.complete());
  return operation;
}

export function createQueuedRun(sessionKey: string, sessionId: string, agentId = "main") {
  return createRpcSourceForTest(
    {},
    {
      storeScope: fixtureStorePath(agentId),
      phase: "waiting",
      sessionKey,
      sessionId,
      agentId,
    },
  );
}

const nativeProducers = new Map<EmbeddedAgentQueueHandle, () => void>();
export function attachActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey: string,
) {
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    resetTriggered: false,
    target: captureSessionTarget({
      storeScope: fixtureStorePath(sessionKey.split(":")[1]),
      sessionKey,
      incarnation: sessionId,
    }),
  });
  const cancelled = createDeferred();
  const originalAbort = handle.abort;
  handle.abort = (...args) => {
    originalAbort(...args);
    cancelled.resolve();
  };
  registerNativeRun(sessionId, handle, sessionKey, undefined, undefined, operation);
  nativeProducers.set(
    handle,
    finishProducer(cancelled, () => {
      clearNativeRun(sessionId, handle, sessionKey);
      operation.complete();
      nativeProducers.delete(handle);
    }),
  );
}
export function detachActiveEmbeddedRun(
  _sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  _sessionKey: string,
) {
  nativeProducers.get(handle)?.();
}
