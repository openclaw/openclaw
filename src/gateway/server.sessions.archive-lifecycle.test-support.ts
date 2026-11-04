import { expectDefined } from "@openclaw/normalization-core";
import { expect, onTestFinished, vi } from "vitest";
import { getRuntimeConfig as getHostRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { markChatAbortTerminalPersistenceError } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";
import { soloClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";
import type { resolveSessionMutationAuthorization } from "./session-sharing.js";
import {
  getGatewayConfigModule,
  getSessionsHandlers,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

export async function activeRunContext(params: {
  runId: string;
  sessionId: string;
  sessionKey: string;
  persistence: ReturnType<typeof createDeferredCore<void>>;
  ownerConnId?: string;
  terminalPersistenceError?: Error;
}) {
  const { runId, sessionId, sessionKey, persistence, ownerConnId, terminalPersistenceError } =
    params;
  rpcSourceTesting.clear();
  const registration = registerChatAbortController({
    runId,
    sessionId,
    sessionKey,
    sourceWork: persistence.promise,
    target: captureSessionTarget({
      storeScope: resolveSessionStorePathCore(getHostRuntimeConfig().session?.store),
      sessionKey,
      incarnation: sessionId,
    }),
    timeoutMs: 60_000,
    ownerConnId,
  });
  const entry = expectDefined(registration.entry, "active run registration");
  onTestFinished(registration.cleanup);
  const claim = await claimSessionControllerTask(entry.input, (mailboxClaim) => {
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      target: entry.input.target,
      mailboxClaim,
    });
    markReplyOperationExecutionStarted(operation);
    operation.setPhase("running");
  });
  const activeOperation = expectDefined(claim.operation, "active run operation");
  const finish = () => {
    activeOperation.complete();
    releaseSessionControllerClaim(claim);
  };
  const aborted = createDeferredCore();
  const onAbort = () => aborted.resolve();
  entry.input.abortSignal.addEventListener("abort", onAbort, { once: true });
  const terminalStarted = createDeferredCore();
  const unsubscribe = onAgentEvent((event) => {
    if (event.runId !== runId || event.stream !== "lifecycle" || event.data.phase !== "end") {
      return;
    }
    entry.adapter.projectSessionTerminalPending = false;
    entry.adapter.projectSessionTerminalPersistence = persistence.promise;
    void persistence.promise.then(
      () => {
        entry.adapter.projectSessionTerminalPersistence = undefined;
        entry.adapter.projectSessionTerminalPersisted = true;
        finish();
      },
      (error: unknown) => {
        markChatAbortTerminalPersistenceError(entry, error);
        finish();
      },
    );
    terminalStarted.resolve();
    if (terminalPersistenceError) {
      persistence.reject(terminalPersistenceError);
    }
  });
  const chatRunState = createChatRunState();
  return {
    aborted: aborted.promise,
    context: {
      agentRunSeq: new Map([[runId, 0]]),
      broadcast: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      rpcSourceTesting,
      chatRunState,
      logGateway: { warn: vi.fn() },
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => ({ sessionKey, clientRunId: runId })),
    },
    controller: registration.controller,
    terminalStarted: terminalStarted.promise,
    unsubscribe(this: void) {
      entry.input.abortSignal.removeEventListener("abort", onAbort);
      unsubscribe();
      finish();
      registration.cleanup();
    },
  };
}

export function waitForArchivePhase(
  phase: Promise<unknown>,
  archive: Promise<unknown>,
  signal: AbortSignal,
) {
  return racePromiseWithAbortSignal(
    Promise.race([
      phase,
      archive.then((result) => {
        throw new Error("Archive settled before the expected fixture phase", { cause: result });
      }),
    ]),
    signal,
  );
}

export function identifiedClient(profileId: string): GatewayClient {
  return {
    ...soloClient(),
    connId: `${profileId}-connection`,
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: gatewayProfile(profileId, profileId),
  };
}

export function workerPlacement(params: {
  sessionId: string;
  sessionKey: string;
  state: WorkerSessionPlacementRecord["state"];
  agentId?: string;
  environmentId?: string | null;
}): WorkerSessionPlacementRecord {
  const { state } = params;
  const awaitingEnvironment = state === "local" || state === "requested";
  const awaitingBundle = awaitingEnvironment || state === "provisioning";
  const awaitingWorkspace = awaitingBundle || state === "syncing";
  const owned = ["active", "draining", "reconciling", "reclaimed", "failed"].includes(state);
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? "main",
    executionMode: "worker-turn",
    state,
    generation: 2,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId:
      params.environmentId !== undefined
        ? params.environmentId
        : awaitingEnvironment
          ? null
          : "worker-environment",
    activeOwnerEpoch: owned ? 1 : null,
    workspaceBaseManifestRef: awaitingWorkspace ? null : "manifest-ref",
    remoteWorkspaceDir: awaitingWorkspace ? null : "/workspace",
    workerBundleHash: awaitingBundle ? null : "bundle-hash",
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: state === "failed" ? "worker recovery stopped" : null,
  } as WorkerSessionPlacementRecord;
}

export function placementReader(current: () => WorkerSessionPlacementRecord | undefined) {
  return {
    async prepareSessionPlacement(sessionId: string) {
      return {
        prepareRead: () => undefined,
        current: () => {
          const placement = current();
          return placement?.sessionId === sessionId ? placement : undefined;
        },
        release() {},
      };
    },
    getMany(sessionIds: readonly string[]) {
      const placement = current();
      return new Map(
        placement && sessionIds.includes(placement.sessionId)
          ? [[placement.sessionId, placement]]
          : [],
      );
    },
  };
}

export async function archiveLifecycleRequestContext(
  overrides: Record<string, unknown>,
): Promise<GatewayRequestContext> {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const loadGatewayModelCatalog = async () => [];
  return {
    trackExecution: trackAsyncWork,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    getRuntimeConfig,
    loadGatewayModelCatalog,
    readPreparedGatewayModelCatalog: async () => ({ entries: await loadGatewayModelCatalog() }),
    ...overrides,
  } as unknown as GatewayRequestContext;
}

type LifecycleHandlerResponse = {
  ok: boolean;
  payload?: unknown;
  error?: Parameters<RespondFn>[2];
};

type HandlerContext = { client: GatewayClient; context: GatewayRequestContext };

async function handlerResponse(
  method: "sessions.patch" | "session.visibility.set",
  { client, context }: HandlerContext,
  params: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const handlers = await getSessionsHandlers();
  let response: LifecycleHandlerResponse | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await handlers[method]?.({ client, context, params, respond, ...extra } as never);
  return expectDefined(response, "lifecycle handler response");
}

export function archiveTarget(key: string, expectedSessionId: string) {
  return { key, expectedSessionId };
}

export function expectArchived(storePath: string, sessionKey: string) {
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
}

export async function invokeArchiveHandler(
  params: HandlerContext & {
    authorization: NonNullable<
      ReturnType<typeof resolveSessionMutationAuthorization>["authorization"]
    >;
    sessionKey: string;
    expectedSessionId: string;
  },
): Promise<LifecycleHandlerResponse> {
  const target = archiveTarget(params.sessionKey, params.expectedSessionId);
  return handlerResponse(
    "sessions.patch",
    params,
    { ...target, archived: true },
    {
      req: {} as never,
      isWebchatConnect: () => false,
      sessionMutationAuthorization: params.authorization,
    },
  );
}

export async function invokeVisibilityHandler(
  params: HandlerContext & {
    sessionKey: string;
    visibility: "draft" | "shared";
  },
): Promise<LifecycleHandlerResponse> {
  return handlerResponse("session.visibility.set", params, {
    sessionKey: params.sessionKey,
    visibility: params.visibility,
  });
}
