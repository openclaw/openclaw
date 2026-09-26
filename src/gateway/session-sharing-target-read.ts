import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
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
  hiddenSessionNotFound,
  resolveSessionSharingTarget,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import {
  resolveDirectSessionTargets,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import type {
  GatewaySessionStoreCache,
  GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";

export const readProjectedSessionMutationTarget = (
  targetRef: SessionMutationTarget,
  cfg: OpenClawConfig,
  projection: SessionRowProjection,
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
    return {
      target: resolveSessionSharingTarget({
        cfg: params.cfg,
        sessionKey: params.targetRef.sessionKey,
        agentId: input.value,
        ...params.lookupCaches(),
        exactRead: params.targetCount === 1,
      }),
    };
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return {
        error: errorShape(ErrorCodes.INVALID_REQUEST, error.message),
      };
    }
    throw error;
  }
}
