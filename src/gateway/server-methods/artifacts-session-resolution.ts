import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ArtifactsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { resolveSessionKeyForRun } from "../server-session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  createSessionListEntryFilter,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../session-store-key.js";
import type { ArtifactLookup } from "./artifacts-content.js";
import type { GatewayClient, RespondFn } from "./types.js";

export type ArtifactQuery = ArtifactsListParams;

type ResolvedArtifactSession = {
  sessionKey: string;
  agentId?: string;
};

function resolveArtifactSessionAgentId(
  sessionKey: string | undefined,
  cfg?: OpenClawConfig,
): string | undefined {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(key);
  if (!parsed && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  if (cfg) {
    const owner = resolveRequestedSessionAgentId(cfg, key);
    if (!owner.ok) {
      throw new ArtifactSessionResolutionError(owner.error);
    }
    return owner.agentId;
  }
  return parsed?.agentId ?? resolveAgentIdFromSessionKey(key);
}

function resolveScopedArtifactSessionKey(
  sessionKey: string | undefined,
  agentId: string | undefined,
  cfg?: OpenClawConfig,
): string | undefined {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return undefined;
  }
  const scopedAgentId = normalizeOptionalString(agentId);
  if (!scopedAgentId) {
    return key;
  }
  const parsed = parseAgentSessionKey(key);
  if (!parsed && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  if (!cfg) {
    return parsed && parsed.agentId !== normalizeAgentId(scopedAgentId)
      ? undefined
      : toAgentStoreSessionKey({ agentId: scopedAgentId, requestKey: key });
  }
  const scopedKey = resolveStoredSessionKeyForAgentStore({
    cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
  return scopedKey !== "global" &&
    scopedKey !== "unknown" &&
    resolveSessionStoreAgentId(cfg, scopedKey) !== normalizeAgentId(scopedAgentId)
    ? undefined
    : scopedKey;
}

function resolveQuerySession(
  query: ArtifactQuery,
  cfg: OpenClawConfig | undefined,
): ResolvedArtifactSession | undefined {
  if (query.sessionKey) {
    const sessionKey = resolveScopedArtifactSessionKey(query.sessionKey, query.agentId, cfg);
    return sessionKey
      ? { sessionKey, ...(query.agentId ? { agentId: query.agentId } : {}) }
      : undefined;
  }
  if (query.runId) {
    // A live run context can resolve its own agent-scoped key. Do not force an
    // unrelated default-agent selection before consulting that authoritative row.
    const sessionKey = resolveSessionKeyForRun(
      query.runId,
      query.agentId ? { agentId: query.agentId } : {},
    );
    const agentId =
      query.agentId ??
      resolveArtifactSessionAgentId(sessionKey, cfg) ??
      resolveSessionAgentId({ config: cfg });
    const scopedSessionKey = resolveScopedArtifactSessionKey(sessionKey, agentId, cfg);
    return scopedSessionKey ? { sessionKey: scopedSessionKey, agentId } : undefined;
  }
  return undefined;
}

export class ArtifactSessionResolutionError extends Error {
  constructor(readonly shape: ReturnType<typeof errorShape>) {
    super(shape.message);
  }
}

export function artifactResponseIsCurrent(found: ArtifactLookup, respond: RespondFn): boolean {
  try {
    found.assertCurrent?.();
    return true;
  } catch (error) {
    if (!(error instanceof ArtifactSessionResolutionError)) {
      throw error;
    }
    respond(false, undefined, error.shape);
    return false;
  }
}

export async function prepareArtifactSessionResolution(
  input: ArtifactQuery,
): Promise<
  (
    cfg: OpenClawConfig | undefined,
    client: GatewayClient | null,
  ) => ResolvedArtifactSession | undefined
> {
  const query = { ...input };
  // Resolve the native session/run selector under current disclosure policy.
  return (cfg, client) => {
    const sessionKey = normalizeOptionalString(query.sessionKey);
    let scopedQuery = query;
    if (sessionKey && cfg) {
      const owner = resolveRequestedSessionAgentId(cfg, sessionKey, query.agentId);
      if (!owner.ok) {
        throw new ArtifactSessionResolutionError(owner.error);
      }
      scopedQuery = { ...query, agentId: owner.agentId };
    }
    const resolved = resolveQuerySession(scopedQuery, cfg);
    if (!resolved) {
      return undefined;
    }
    const target = resolveSessionSharingTarget({
      cfg: cfg ?? {},
      sessionKey: resolved.sessionKey,
      agentId: resolved.agentId,
    });
    const error = authorizeIncognitoSessionTarget({
      client,
      sessionKey: query.sessionKey ?? resolved.sessionKey,
      target,
    });
    const visibilityDenied = Boolean(
      target &&
      createSessionListEntryFilter({ client, cfg })?.(target.storeKey, target.entry) === false,
    );
    if (!error && !visibilityDenied) {
      return resolved;
    }
    throw new ArtifactSessionResolutionError(
      query.sessionKey && error
        ? error
        : errorShape(ErrorCodes.INVALID_REQUEST, "no session found for artifact query", {
            details: { type: "artifact_scope_not_found" },
          }),
    );
  };
}
