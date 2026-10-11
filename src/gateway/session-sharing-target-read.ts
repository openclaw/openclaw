import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import { isConfiguredSessionStoreAgentId } from "../config/sessions/targets-configured-agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import type { SessionOperatorScope } from "../shared/session-method-scopes-base.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  resolveRequestedSessionAgentId,
  resolveRequestedSessionAgentInput,
} from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  captureSessionActorMutationFacts,
  captureSessionSharingActorBinding,
} from "./session-sharing-incognito.js";
import {
  hiddenSessionNotFound,
  resolveSessionSharingTarget,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import {
  captureSessionMutationRouting,
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";
import {
  resolveDirectSessionTargets,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import type { GatewaySessionStoreCache } from "./session-utils-store-lookup.js";

export type SessionSharingReadProjection = Pick<
  SessionRowProjection,
  | "sharingTarget"
  | "sharingTargetState"
  | "readSource"
  | "readMembership"
  | "needsMembershipPreparation"
  | "prepareMembership"
>;

export function isSameSessionSharingTarget(
  target: SessionSharingTarget | null,
  selected: SessionSharingTarget,
): boolean {
  return Boolean(
    target &&
    target.agentId === selected.agentId &&
    target.canonicalKey === selected.canonicalKey &&
    target.storeKey === selected.storeKey &&
    target.storePath === selected.storePath &&
    target.entry.sessionId === selected.entry.sessionId &&
    target.entry.lifecycleRevision === selected.entry.lifecycleRevision &&
    target.readSource?.path === selected.readSource?.path &&
    target.readSource?.agentId === selected.readSource?.agentId &&
    target.readSource?.databaseIdentity === selected.readSource?.databaseIdentity &&
    target.readSource?.databaseBirthtime === selected.readSource?.databaseBirthtime,
  );
}

/** Reuse admitted sharing facts; aliases, excluded rows, and incognito keep native custody. */
export async function prepareSessionSharingRead(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  preserveQualifiedAddress?: boolean;
  projection?: SessionSharingReadProjection;
}) {
  try {
    if (captureSessionSharingActorBinding({ ...params, resolved: null })) {
      return prepareSessionMutationFacts({ ...params, allowMissing: true });
    }
    const { cfg, projection } = params;
    const query = { key: params.sessionKey, agentId: params.agentId };
    const resident = projection?.sharingTarget(query);
    const source = resident && projection?.readSource({ ...query, storePath: resident.storePath });
    const configuredStorePath = resolveSessionStorePathCore(cfg.session?.store, {
      agentId: params.agentId,
    });
    const configuredSource = captureSessionStoreReadCandidate(
      resolveUnsuffixedSqliteTargetFromSessionStorePath(configuredStorePath).path,
    );
    // Run selectors retain their stored address even after the configured main alias moves.
    const captured =
      !params.preserveQualifiedAddress &&
      resident &&
      source?.path === resident.storePath &&
      typeof source.databaseIdentity === "string" &&
      isConfiguredSessionStoreAgentId(cfg, resident.agentId) &&
      source.path === configuredSource.physicalPath
        ? { ...resident, readSource: source }
        : undefined;
    if (!captured || !projection) {
      return prepareSessionMutationFacts({ ...params, allowMissing: true });
    }
    const assertRouting = captureSessionMutationRouting(cfg);
    // Capture before readiness yields so a replacement cannot become the selected session.
    while (projection.needsMembershipPreparation()) {
      await projection.prepareMembership();
    }
    let active = true;
    const readCurrent = (currentCfg: OpenClawConfig) => {
      try {
        if (!active) {
          throw new SessionMutationFactsUnavailableError();
        }
        assertRouting(currentCfg);
        assertSessionStoreReadCandidate(configuredSource.path, [configuredSource]);
        const current = readProjectedSessionMutationTarget(
          { sessionKey: params.sessionKey, agentId: params.agentId },
          currentCfg,
          projection,
        );
        if (current.status !== "ready" || !isSameSessionSharingTarget(current.target, captured)) {
          throw new SessionMutationFactsUnavailableError();
        }
        const target = current.target;
        return {
          target,
          sourcePath: captured.readSource.path,
          sourceAgentId: captured.readSource.agentId,
          membership:
            projection.readMembership({ ...query, storePath: target.storePath }) ??
            new Set<string>(),
        };
      } catch (error) {
        throw error instanceof SessionMutationFactsUnavailableError
          ? error
          : new SessionMutationFactsUnavailableError({ cause: error });
      }
    };
    readCurrent(cfg);
    return {
      storageTarget: {
        agentId: captured.agentId,
        canonicalKey: captured.canonicalKey,
        storePath: configuredStorePath,
      },
      readCurrent,
      release: () => {
        active = false;
      },
    };
  } catch (error) {
    throw error instanceof SessionMutationFactsUnavailableError
      ? error
      : new SessionMutationFactsUnavailableError({ cause: error });
  }
}

export const readProjectedSessionMutationTarget = (
  targetRef: SessionMutationTarget,
  cfg: OpenClawConfig,
  projection: Pick<SessionSharingReadProjection, "sharingTargetState" | "readSource">,
): { status: "ready"; target: SessionSharingTarget } | { status: "pending" | "unavailable" } => {
  const agent = resolveRequestedSessionAgentId(cfg, targetRef.sessionKey, targetRef.agentId);
  if (!agent.ok) {
    return { status: "unavailable" };
  }
  const query = { key: targetRef.sessionKey, agentId: agent.agentId };
  const state = projection.sharingTargetState(query);
  if (state.status !== "ready") {
    return { status: state.status === "pending" ? "pending" : "unavailable" };
  }
  const readSource = projection.readSource({ ...query, storePath: state.target.storePath });
  // Legacy selectors and filesystem aliases retain the native candidate-selection contract.
  if (
    !readSource ||
    readSource.path !== state.target.storePath ||
    typeof readSource.databaseIdentity !== "string"
  ) {
    return { status: "unavailable" };
  }
  assertExistingDatabaseIdentity(
    readSource.path,
    `file:${readSource.databaseIdentity}`,
    readSource.databaseBirthtime,
  );
  return { status: "ready", target: { ...state.target, readSource } };
};

export function readSessionMutationTarget(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  expectedTarget?: { storePath: string };
  method: string;
  requestParams: unknown;
  sessionScope?: SessionOperatorScope;
  sessionRowRead?: SessionRowReadView;
  targetRef: SessionMutationTarget;
  targetCount: number;
  lookupCaches: () => {
    storeCache: GatewaySessionStoreCache;
    targetDiscoveryCache: GatewaySessionStoreDiscoveryCache;
  };
}):
  | {
      target: SessionSharingTarget | null;
      preparedReadSource?: SessionSharingTarget["readSource"];
      projection?: SessionRowProjection;
    }
  | { error: ErrorShape } {
  const input = resolveRequestedSessionAgentInput(
    params.targetRef.sessionKey,
    params.targetRef.agentId,
  );
  if (!input.ok) {
    return { error: input.error };
  }
  try {
    const binding = captureSessionSharingActorBinding({ ...params.targetRef, resolved: null });
    if (binding) {
      const { agentId, canonicalKey } = resolveSessionStoreIdentity({
        cfg: params.cfg,
        ...params.targetRef,
      });
      const facts = captureSessionActorMutationFacts(
        binding,
        canonicalKey,
        true,
        params.cfg.session?.store &&
          resolveSessionStorePathCore(params.cfg.session.store, { agentId }),
      );
      return { target: facts.readCurrent().target, preparedReadSource: facts.source };
    }
    const projection = getSessionRowProjection(params.context);
    const projected =
      projection && readProjectedSessionMutationTarget(params.targetRef, params.cfg, projection);
    // Prepared callers retain logical locators; resident rows expose physical store paths.
    if (
      projected?.status === "ready" &&
      (!params.expectedTarget || projected.target.storePath === params.expectedTarget.storePath)
    ) {
      return {
        target: projected.target,
        preparedReadSource: projected.target.readSource,
        projection,
      };
    }
    if (
      params.sessionRowRead &&
      resolveDirectSessionTargets(params.method, params.requestParams).some(
        (direct) =>
          direct.sessionKey === params.targetRef.sessionKey &&
          direct.agentId === params.targetRef.agentId,
      )
    ) {
      const agent = resolveRequestedSessionAgentId(
        params.sessionRowRead.state.cfg,
        params.targetRef.sessionKey,
        params.targetRef.agentId,
      );
      if (!agent.ok) {
        return { error: agent.error };
      }
      const row = params.sessionRowRead.describe({
        key: params.targetRef.sessionKey,
        agentId: agent.agentId,
      });
      if (!row && params.sessionScope === "operator.sessions.read") {
        return { error: hiddenSessionNotFound(params.targetRef.sessionKey) };
      }
      const readSource = row && params.sessionRowRead.readSource(row);
      return {
        preparedReadSource: readSource,
        target: row?.storedEntry
          ? {
              agentId: row.agentId,
              canonicalKey: row.key,
              storeKey: row.key,
              storeKeys: [row.key],
              storePath: row.storeTarget.storePath,
              readSource,
              entry: row.storedEntry,
            }
          : null,
      };
    }
    let preparedReadSource: SessionSharingTarget["readSource"];
    const target = resolveSessionSharingTarget({
      cfg: params.cfg,
      sessionKey: params.targetRef.sessionKey,
      agentId: input.value,
      ...params.lookupCaches(),
      exactRead: params.targetCount === 1,
      onReadSource: (source) => {
        preparedReadSource = source;
      },
    });
    return { target, preparedReadSource };
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return {
        error: errorShape(ErrorCodes.INVALID_REQUEST, error.message),
      };
    }
    throw error;
  }
}
