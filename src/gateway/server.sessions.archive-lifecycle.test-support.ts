import { expect, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { markChatAbortTerminalPersistenceError } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController, removeChatAbortControllerEntry } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import type { resolveSessionMutationAuthorization } from "./session-sharing.js";
import {
  getGatewayConfigModule,
  getSessionsHandlers,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

export function activeRunContext(params: {
  runId: string;
  sessionId: string;
  sessionKey: string;
  persistence: ReturnType<typeof createDeferredCore<void>>;
  ownerConnId?: string;
  terminalPersistenceError?: Error;
}) {
  const chatAbortControllers = new Map();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    timeoutMs: 60_000,
    ownerConnId: params.ownerConnId,
  });
  if (!registration.entry) {
    throw new Error("expected active run registration");
  }
  const entry = registration.entry;
  const aborted = createDeferredCore();
  const onAbort = () => aborted.resolve();
  entry.controller.signal.addEventListener("abort", onAbort, { once: true });
  const terminalStarted = createDeferredCore();
  const unsubscribe = onAgentEvent((event) => {
    if (
      event.runId !== params.runId ||
      event.stream !== "lifecycle" ||
      event.data.phase !== "end"
    ) {
      return;
    }
    entry.projectSessionTerminalPending = false;
    entry.projectSessionTerminalPersistence = params.persistence.promise;
    void params.persistence.promise.then(
      () => {
        entry.projectSessionTerminalPersistence = undefined;
        entry.projectSessionTerminalPersisted = true;
        removeChatAbortControllerEntry(chatAbortControllers, params.runId, entry);
      },
      (error: unknown) => {
        markChatAbortTerminalPersistenceError(entry, error);
        removeChatAbortControllerEntry(chatAbortControllers, params.runId, entry);
      },
    );
    terminalStarted.resolve();
    if (params.terminalPersistenceError) {
      params.persistence.reject(params.terminalPersistenceError);
    }
  });
  const chatRunState = createChatRunState();
  return {
    aborted: aborted.promise,
    context: {
      agentRunSeq: new Map([[params.runId, 0]]),
      broadcast: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      chatAbortControllers,
      chatRunState,
      logGateway: { warn: vi.fn() },
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => ({
        sessionKey: params.sessionKey,
        clientRunId: params.runId,
      })),
    },
    controller: registration.controller,
    terminalStarted: terminalStarted.promise,
    unsubscribe(this: void) {
      entry.controller.signal.removeEventListener("abort", onAbort);
      unsubscribe();
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
    connId: `${profileId}-connection`,
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
  };
}

export function workerPlacement(params: {
  sessionId: string;
  sessionKey: string;
  state: WorkerSessionPlacementRecord["state"];
  agentId?: string;
  environmentId?: string | null;
}): WorkerSessionPlacementRecord {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? "main",
    state: params.state,
    generation: 2,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId:
      params.environmentId !== undefined
        ? params.environmentId
        : params.state === "local" || params.state === "requested"
          ? null
          : "worker-environment",
    activeOwnerEpoch: ["active", "draining", "reconciling", "reclaimed", "failed"].includes(
      params.state,
    )
      ? 1
      : null,
    workspaceBaseManifestRef:
      params.state === "local" ||
      params.state === "requested" ||
      params.state === "provisioning" ||
      params.state === "syncing"
        ? null
        : "manifest-ref",
    remoteWorkspaceDir:
      params.state === "local" ||
      params.state === "requested" ||
      params.state === "provisioning" ||
      params.state === "syncing"
        ? null
        : "/workspace",
    workerBundleHash:
      params.state === "local" || params.state === "requested" || params.state === "provisioning"
        ? null
        : "bundle-hash",
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: params.state === "failed" ? "worker recovery stopped" : null,
  } as WorkerSessionPlacementRecord;
}

export function placementReader(current: () => WorkerSessionPlacementRecord | undefined) {
  return {
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
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    getRuntimeConfig,
    loadGatewayModelCatalog,
    readPreparedGatewayModelCatalog: async () => ({ entries: await loadGatewayModelCatalog() }),
    ...overrides,
  } as unknown as GatewayRequestContext;
}

export type LifecycleHandlerResponse = {
  ok: boolean;
  payload?: unknown;
  error?: Parameters<RespondFn>[2];
};

export function archivePatch(key: string, expectedSessionId: string) {
  return { key, archived: true, expectedSessionId };
}

export function archiveTarget(key: string, expectedSessionId: string) {
  return { key, expectedSessionId };
}

export function expectArchived(storePath: string, sessionKey: string) {
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
}

export async function invokeArchiveHandler(params: {
  authorization: NonNullable<
    ReturnType<typeof resolveSessionMutationAuthorization>["authorization"]
  >;
  client: GatewayClient;
  context: GatewayRequestContext;
  sessionKey: string;
  expectedSessionId: string;
}): Promise<LifecycleHandlerResponse> {
  const handlers = await getSessionsHandlers();
  let response: LifecycleHandlerResponse | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await handlers["sessions.patch"]?.({
    req: {} as never,
    params: archivePatch(params.sessionKey, params.expectedSessionId),
    client: params.client,
    context: params.context,
    isWebchatConnect: () => false,
    sessionMutationAuthorization: params.authorization,
    respond,
  } as never);
  if (!response) {
    throw new Error("sessions.patch did not respond");
  }
  return response;
}

export async function invokeVisibilityHandler(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  sessionKey: string;
  visibility: "draft" | "shared";
}): Promise<LifecycleHandlerResponse> {
  const handlers = await getSessionsHandlers();
  let response: LifecycleHandlerResponse | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await handlers["session.visibility.set"]?.({
    params: { sessionKey: params.sessionKey, visibility: params.visibility },
    client: params.client,
    context: params.context,
    respond,
  } as never);
  if (!response) {
    throw new Error("session.visibility.set did not respond");
  }
  return response;
}
