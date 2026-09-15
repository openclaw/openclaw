import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readAgentRunIndexVersion } from "../../infra/agent-run-registry.js";
import type { DiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  readSessionIdentityMutationVersion,
  readSessionLifecycleVersion,
} from "../../sessions/session-lifecycle-events.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import {
  readOpenClawAgentDatabaseRegistryToken,
  readOpenIncognitoAgentDatabaseGeneration,
} from "../../state/openclaw-agent-db.js";
import { readUserProfileVersion } from "../../state/user-profile-events.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { operatorSessionCap, resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { readPreparedGatewayModelCatalogMetadata } from "../server-model-catalog-view.js";
import { readSessionActivitySummaryVersion } from "../session-activity-summary-state.js";
import { readSessionAutomationVersion } from "../session-automation-index.js";
import { readSessionLifecyclePersistenceVersion } from "../session-lifecycle-state.js";
import { readSessionObserverDigestVersion } from "../session-observer-model.js";
import { isGatewayAdmin, sharingIdentity } from "../session-sharing-policy.js";
import { readSessionTitleProjectionUnavailableVersion } from "../session-transcript-title-reader.js";
import type { SessionListModelCatalog, SessionsListResult } from "../session-utils.types.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { readSessionsMutationVersion } from "./session-change-event.js";
import type { SessionListDiagnostics } from "./sessions-list-diagnostics.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type SessionListHardFence = {
  gatewayAccessRevision: number;
  agentDatabaseRegistryToken: symbol;
  incognitoDatabaseGeneration: number;
  sessionIdentityMutationVersion: number;
  userProfileVersion: number;
};
type SessionListFence = SessionListHardFence & {
  agentRunIndexVersion: number;
  lifecyclePersistenceVersion: number;
  sessionAutomationVersion: number;
  sessionLifecycleVersion: number;
  sessionObserverDigestVersion: number;
  sessionActivitySummaryVersion: number;
  sessionsMutationVersion: number;
  sessionTranscriptUpdateVersion: number;
  titleProjectionUnavailableVersion: number;
  workerEnvironmentInventoryVersion: number;
  workerMachineShapeVersion: number;
  workerPlacementDiskSpaceVersion: number;
  workerPlacementRunnerAvailabilityVersion: number;
};
type CatalogFence = { modelCatalogRevision: string };
type SessionListOperation = CatalogFence & {
  promise: Promise<SessionsListResult>;
  workTrace?: DiagnosticTraceContext;
};
type SessionListCompleted = CatalogFence & { expiresAt?: number; result: SessionsListResult };
type SessionListState = SessionListFence & {
  completed: Map<string, SessionListCompleted>;
  config: OpenClawConfig;
  inFlight: Map<string, SessionListOperation>;
};

const SESSIONS_LIST_COMPLETED_CACHE_LIMIT = 64;
// Match the Control UI's maximum wait for a debounced session-list refresh.
const SESSIONS_LIST_LIVE_REUSE_MS = 1_000;
const sessionListsByContext = new WeakMap<GatewayRequestContext, SessionListState>();
const modelCatalogRevisions = new WeakMap<object, number>();
let nextModelCatalogRevision = 1;

function readModelCatalogRevision(modelCatalog: object | undefined): number {
  if (!modelCatalog) {
    return 0;
  }
  const existing = modelCatalogRevisions.get(modelCatalog);
  if (existing !== undefined) {
    return existing;
  }
  const revision = nextModelCatalogRevision++;
  modelCatalogRevisions.set(modelCatalog, revision);
  return revision;
}

/**
 * Serializes the per-agent catalog revision set so the cache fence advances
 * when any row owner's entries or provider policy changes. A new read wrapper
 * alone does not invalidate the cache; the prepared facts retain stable identity.
 */
function readSessionListModelCatalogFence(
  modelCatalog: SessionListModelCatalog | undefined,
): string {
  if (!modelCatalog || modelCatalog.size === 0) {
    return "none";
  }
  return [...modelCatalog.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([agentId, catalog]) =>
        `${agentId}:${readModelCatalogRevision(catalog?.entries)}:${readModelCatalogRevision(catalog?.pluginRegistry)}:${readModelCatalogRevision(readPreparedGatewayModelCatalogMetadata(catalog))}`,
    )
    .join(",");
}

function readSessionListFence(context: GatewayRequestContext): SessionListFence {
  return {
    gatewayAccessRevision: readGatewayAccessRevision(),
    agentRunIndexVersion: readAgentRunIndexVersion(),
    agentDatabaseRegistryToken: readOpenClawAgentDatabaseRegistryToken(),
    incognitoDatabaseGeneration: readOpenIncognitoAgentDatabaseGeneration(),
    lifecyclePersistenceVersion: readSessionLifecyclePersistenceVersion(),
    sessionAutomationVersion: readSessionAutomationVersion(),
    sessionIdentityMutationVersion: readSessionIdentityMutationVersion(),
    sessionLifecycleVersion: readSessionLifecycleVersion(),
    sessionObserverDigestVersion: readSessionObserverDigestVersion(),
    sessionActivitySummaryVersion: readSessionActivitySummaryVersion(),
    userProfileVersion: readUserProfileVersion(),
    sessionsMutationVersion: readSessionsMutationVersion(context),
    // Rows embed transcript-derived previews/titles; a committed transcript
    // write without a session mutation must still fence new projection work.
    sessionTranscriptUpdateVersion: readSessionTranscriptUpdateVersion(),
    titleProjectionUnavailableVersion: readSessionTitleProjectionUnavailableVersion(),
    workerEnvironmentInventoryVersion: context.workerEnvironmentService?.inventoryVersion() ?? 0,
    workerMachineShapeVersion: context.workerEnvironmentService?.machineShapeVersion() ?? 0,
    workerPlacementDiskSpaceVersion: context.workerPlacementDiskSpaceReader?.version() ?? 0,
    workerPlacementRunnerAvailabilityVersion:
      context.workerPlacementRunnerAvailabilityReader?.version() ?? 0,
  };
}

function matchesSessionListHardFence(
  value: SessionListHardFence,
  fence: SessionListHardFence,
): boolean {
  return (
    value.gatewayAccessRevision === fence.gatewayAccessRevision &&
    value.agentDatabaseRegistryToken === fence.agentDatabaseRegistryToken &&
    value.incognitoDatabaseGeneration === fence.incognitoDatabaseGeneration &&
    value.sessionIdentityMutationVersion === fence.sessionIdentityMutationVersion &&
    value.userProfileVersion === fence.userProfileVersion
  );
}

function matchesSessionListFence(value: SessionListFence, fence: SessionListFence): boolean {
  return (
    matchesSessionListHardFence(value, fence) &&
    value.agentRunIndexVersion === fence.agentRunIndexVersion &&
    value.lifecyclePersistenceVersion === fence.lifecyclePersistenceVersion &&
    value.sessionAutomationVersion === fence.sessionAutomationVersion &&
    value.sessionLifecycleVersion === fence.sessionLifecycleVersion &&
    value.sessionObserverDigestVersion === fence.sessionObserverDigestVersion &&
    value.sessionActivitySummaryVersion === fence.sessionActivitySummaryVersion &&
    value.sessionsMutationVersion === fence.sessionsMutationVersion &&
    value.sessionTranscriptUpdateVersion === fence.sessionTranscriptUpdateVersion &&
    value.titleProjectionUnavailableVersion === fence.titleProjectionUnavailableVersion &&
    value.workerEnvironmentInventoryVersion === fence.workerEnvironmentInventoryVersion &&
    value.workerMachineShapeVersion === fence.workerMachineShapeVersion &&
    value.workerPlacementDiskSpaceVersion === fence.workerPlacementDiskSpaceVersion &&
    value.workerPlacementRunnerAvailabilityVersion ===
      fence.workerPlacementRunnerAvailabilityVersion
  );
}

function sessionListWorkKey(
  params: SessionsListParams,
  client: GatewayClient | null,
  config: OpenClawConfig,
): string {
  const actor = resolveGatewayOperatorRoleActor(client);
  return JSON.stringify([
    sharingIdentity(client, actor)?.id ?? null,
    // Attribution also selects owner-first/involving-me rows and membership decoration.
    gatewayClientSessionCreator(client)?.id ?? null,
    isGatewayAdmin(client) ? "admin" : (operatorSessionCap(client, config) ?? null),
    actor?.kind === "system",
    Boolean(client?.authenticatedGitHubIdentitySync),
    Object.entries(params).toSorted(([left], [right]) => left.localeCompare(right)),
  ]);
}

function sessionListState(
  context: GatewayRequestContext,
  config: OpenClawConfig,
): SessionListState {
  let state = sessionListsByContext.get(context);
  const fence = readSessionListFence(context);
  if (!state || state.config !== config || !matchesSessionListFence(state, fence)) {
    const completed = new Map<string, SessionListCompleted>();
    if (state?.config === config && matchesSessionListHardFence(state, fence)) {
      const now = Date.now();
      // Soft changes preserve bounded reuse without extending the original deadline.
      // Idle pages without an expiry still need immediate mutation invalidation.
      for (const [key, entry] of state.completed) {
        if (entry.expiresAt !== undefined && entry.expiresAt > now) {
          completed.set(key, entry);
        }
      }
    }
    // In-flight work stays generation-bound; pending callers must not retain old pages.
    state?.completed.clear();
    state = { ...fence, completed, config, inFlight: new Map() };
    sessionListsByContext.set(context, state);
  }
  return state;
}

function readCompletedSessionList(
  state: SessionListState,
  workKey: string,
  modelCatalogRevision: string,
): SessionsListResult | undefined {
  const completed = state.completed.get(workKey);
  if (
    completed?.modelCatalogRevision === modelCatalogRevision &&
    (completed.expiresAt === undefined || completed.expiresAt > Date.now())
  ) {
    return completed.result;
  }
  // Keep invalid lookups in this synchronous frame, not a suspended refresh.
  state.completed.delete(workKey);
  return undefined;
}

function resolveSessionListExpiration(result: SessionsListResult, now: number): number | undefined {
  let expiresAt: number | undefined;
  for (const session of result.sessions) {
    // Live work can settle without a session/index mutation, running durations tick,
    // and a retained child can sit outside this page. Bound their staleness explicitly.
    if (session.hasActiveRun || session.hasActiveSubagentRun || session.childSessions?.length) {
      expiresAt = Math.min(expiresAt ?? Infinity, now + SESSIONS_LIST_LIVE_REUSE_MS);
    }
    const statusExpiration = session.agentStatus?.expiresAt;
    if (
      statusExpiration !== undefined &&
      (expiresAt === undefined || statusExpiration < expiresAt)
    ) {
      expiresAt = statusExpiration;
    }
  }
  return expiresAt;
}

export async function respondWithCachedSessionList(params: {
  client: GatewayClient | null;
  config: OpenClawConfig;
  context: GatewayRequestContext;
  modelCatalog?: SessionListModelCatalog;
  request: SessionsListParams;
  respond: RespondFn;
  run: () => Promise<SessionsListResult>;
  diagnostics?: SessionListDiagnostics;
}): Promise<void> {
  const workKey = sessionListWorkKey(params.request, params.client, params.config);
  const state = sessionListState(params.context, params.config);
  const modelCatalogRevision = readSessionListModelCatalogFence(params.modelCatalog);
  // Activity windows and child retention expire without mutations; hidden paginated rows
  // prevent deriving a safe deadline, so only concurrent temporal requests share work.
  // Rejected and off-page candidates can change live/goal state without a store write.
  // Searches and active-only reads may coalesce in flight, but cannot reuse completed pages.
  const cacheCompleted =
    params.request.activeMinutes === undefined &&
    params.request.activeOnly !== true &&
    !params.request.spawnedBy &&
    !params.request.search?.trim();
  const completed = cacheCompleted
    ? readCompletedSessionList(state, workKey, modelCatalogRevision)
    : undefined;
  if (completed) {
    params.diagnostics?.setCacheRole("completed-hit");
    params.diagnostics?.setSelectedRowCount(completed.count);
    params.respond(true, completed, undefined);
    return;
  }
  const pending = state.inFlight.get(workKey);
  if (pending?.modelCatalogRevision === modelCatalogRevision) {
    params.diagnostics?.setCacheRole("in-flight-follower", pending.workTrace);
    const result = await pending.promise;
    params.diagnostics?.setSelectedRowCount(result.count);
    params.respond(true, result, undefined);
    return;
  }

  // A request may share only work begun at the same fence. A transition during projection
  // leaves current callers intact but fences every later caller and cache write.
  params.diagnostics?.setCacheRole("projection-owner");
  const promise = Promise.resolve()
    .then(params.run)
    .then((result) => {
      if (
        cacheCompleted &&
        sessionListsByContext.get(params.context) === state &&
        matchesSessionListFence(state, readSessionListFence(params.context)) &&
        readSessionListModelCatalogFence(params.modelCatalog) === modelCatalogRevision
      ) {
        const now = Date.now();
        const expiresAt = resolveSessionListExpiration(result, now);
        if (expiresAt === undefined || expiresAt > now) {
          state.completed.delete(workKey);
          state.completed.set(workKey, { modelCatalogRevision, result, expiresAt });
          pruneMapToMaxSize(state.completed, SESSIONS_LIST_COMPLETED_CACHE_LIMIT);
        }
      }
      return result;
    });
  const operation = { modelCatalogRevision, promise, workTrace: params.diagnostics?.trace };
  state.inFlight.set(workKey, operation);
  try {
    const result = await promise;
    params.diagnostics?.setSelectedRowCount(result.count);
    params.respond(true, result, undefined);
  } finally {
    if (state.inFlight.get(workKey) === operation) {
      state.inFlight.delete(workKey);
    }
  }
}
