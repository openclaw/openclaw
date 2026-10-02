import {
  ErrorCodes,
  errorShape,
  type ArtifactsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionForRun } from "../server-session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "../session-sharing-preparation.js";
import {
  authorizeIncognitoSessionTarget,
  createSessionListEntryFilter,
} from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import type { ArtifactLookup } from "./artifacts-content.js";
import type { GatewayClient, RespondFn } from "./types.js";

export type ArtifactQuery = ArtifactsListParams;

type ResolvedArtifactSession = {
  sessionKey: string;
  agentId: string;
};

type ArtifactSessionProjection = Pick<
  SessionRowProjection,
  "ensureMaterialized" | "findBySessionId" | "sharingRevision"
>;

export type ArtifactSessionAccess = {
  getRuntimeConfig: () => OpenClawConfig;
  client: GatewayClient | null;
  projection?: ArtifactSessionProjection;
  retain: (release: () => void) => void;
};

/** RPCs and HTTP readers release their facts unless a download grant adopts them. */
export function createArtifactSessionAccess(params: Omit<ArtifactSessionAccess, "retain">) {
  const releases = new Set<() => void>();
  return {
    ...params,
    retain(release: () => void) {
      releases.add(release);
    },
    detach(release: () => void) {
      releases.delete(release);
    },
    [Symbol.dispose]() {
      for (const release of releases) {
        release();
      }
      releases.clear();
    },
  };
}

function resolveQuerySession(
  query: ArtifactQuery,
  cfg: OpenClawConfig,
  projection?: ArtifactSessionProjection,
): ResolvedArtifactSession | undefined {
  const selected =
    !query.sessionKey && query.runId
      ? resolveSessionForRun(query.runId, {
          ...(query.agentId ? { agentId: query.agentId } : {}),
          ...(projection ? { projection } : {}),
        })
      : undefined;
  const sessionKey = query.sessionKey ?? selected?.sessionKey;
  if (!sessionKey) {
    return undefined;
  }
  let agentId = query.agentId ?? selected?.agentId;
  if (query.sessionKey) {
    const owner = resolveRequestedSessionAgentId(cfg, sessionKey, agentId);
    if (!owner.ok) {
      throw new ArtifactSessionResolutionError(owner.error);
    }
    agentId = owner.agentId;
  }
  const identity = resolveSessionStoreIdentity({
    cfg,
    sessionKey,
    agentId,
    preserveQualifiedAddress: !query.sessionKey,
  });
  return { sessionKey: identity.canonicalKey, agentId: identity.agentId };
}

export class ArtifactSessionResolutionError extends Error {
  constructor(readonly shape: ReturnType<typeof errorShape>) {
    super(shape.message);
  }
}

function throwArtifactSessionReadError(error: unknown): never {
  if (error instanceof SessionMutationFactsUnavailableError) {
    throw new ArtifactSessionResolutionError(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "session changed while reading artifact; reload the conversation",
        { retryable: true },
      ),
    );
  }
  throw error;
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
  projection?: ArtifactSessionProjection,
) {
  const query = { ...input };
  if (!query.sessionKey && query.runId && projection?.sharingRevision === undefined) {
    await projection?.ensureMaterialized();
  }
  return async (access: ArtifactSessionAccess) => {
    const { client } = access;
    const resolveSession = (cfg: OpenClawConfig) => resolveQuerySession(query, cfg, projection);
    const cfg = access.getRuntimeConfig();
    const resolved = resolveSession(cfg);
    if (!resolved) {
      return undefined;
    }
    const facts = await prepareSessionMutationFacts({
      cfg,
      sessionKey: resolved.sessionKey,
      agentId: resolved.agentId,
      preserveQualifiedAddress: !query.sessionKey,
      allowMissing: true,
    }).catch(throwArtifactSessionReadError);
    access.retain(facts.release);
    const readCurrent = () => {
      try {
        const currentConfig = access.getRuntimeConfig();
        const selected = resolveSession(currentConfig);
        if (selected?.sessionKey !== resolved.sessionKey || selected.agentId !== resolved.agentId) {
          throw new SessionMutationFactsUnavailableError();
        }
        const current = facts.readCurrent(currentConfig);
        const { target } = current;
        const error = authorizeIncognitoSessionTarget({
          client,
          sessionKey: query.sessionKey ?? resolved.sessionKey,
          target,
        });
        const visibilityDenied = Boolean(
          target &&
          createSessionListEntryFilter({ client, cfg: currentConfig })?.(
            target.storeKey,
            target.entry,
          ) === false,
        );
        if (!error && !visibilityDenied) {
          return current;
        }
        throw new ArtifactSessionResolutionError(
          query.sessionKey && error
            ? error
            : errorShape(ErrorCodes.INVALID_REQUEST, "no session found for artifact query", {
                details: { type: "artifact_scope_not_found" },
              }),
        );
      } catch (error) {
        return throwArtifactSessionReadError(error);
      }
    };
    return {
      sessionKey: facts.storageTarget.canonicalKey,
      agentId: facts.storageTarget.agentId,
      ...readCurrent(),
      readCurrent,
      release: facts.release,
    };
  };
}
