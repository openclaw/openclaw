import type { ControlUiSessionPathTarget } from "@openclaw/session-url-contract/parse";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  resolveSessionKeyFromResolveParams,
  withPreparedSessionResolve,
  type SessionsResolveResult,
} from "./sessions-resolve.js";

/** Both HTTP readers use the same URL grammar and the existing session resolution owner. */
export async function resolveControlUiSessionPath(params: {
  target: ControlUiSessionPathTarget;
  projection: SessionRowProjection;
  client: GatewayClient | null;
  publicOnly?: boolean;
  isCurrent?: () => boolean;
}): Promise<{ key: string; agentId: string; isCurrent: () => boolean } | null> {
  const { target, projection } = params;
  if (
    params.publicOnly &&
    target.kind !== "main" &&
    isIncognitoSessionKey(target.kind === "short" ? target.literalSessionKey : target.sessionKey)
  ) {
    return null;
  }
  let isCurrent = () => false;
  const resolve = (p: SessionsResolveParams) => {
    const selection = {
      projection,
      client: params.client,
      isCurrent: params.isCurrent,
      p: {
        ...p,
        agentId: target.agentId,
        allowMissing: true,
        includeGlobal: true,
        includeUnknown: true,
      },
      publicOnly: params.publicOnly,
    };
    return withPreparedSessionResolve(selection, (result) => {
      if (result.ok && "key" in result) {
        const query = { key: result.key, agentId: result.agentId };
        const row = projection.capture(query);
        const sessionId = row?.entry?.sessionId;
        const revision = projection.sharingRevision;
        isCurrent = () => {
          if (
            params.isCurrent?.() === false ||
            !row ||
            !projection.isCurrent(row) ||
            (!isIncognitoSessionKey(query.key) &&
              projection.sharingTargetState(query).status !== "ready") ||
            projection.capture(query)?.entry?.sessionId !== sessionId ||
            projection.sharingRevision === undefined
          ) {
            return false;
          }
          if (projection.sharingRevision === revision) {
            return true;
          }
          // Unrelated session activity must not invalidate an app document.
          // Reapply the original selector's current access policy without yielding.
          try {
            const current = resolveSessionKeyFromResolveParams(selection);
            return (
              current.ok &&
              "key" in current &&
              current.key === result.key &&
              current.agentId === result.agentId
            );
          } catch {
            return false;
          }
        };
      }
      return result;
    });
  };
  let result: SessionsResolveResult;
  if (target.kind === "main") {
    result = await resolve({
      key: resolveAgentMainSessionKey({ cfg: projection.state.cfg, agentId: target.agentId }),
    });
  } else if (target.kind === "short") {
    result = await resolve({ shortId: target.shortId, slugHint: target.slugHint });
    if (result.ok && "missing" in result) {
      result = await resolve({ reference: { key: target.literalSessionKey } });
    }
  } else {
    result = await resolve({
      reference: {
        key: target.sessionKey,
        ...(target.slugCandidate ? { slug: target.slugCandidate } : {}),
      },
    });
  }
  // Never disclose candidates, names, or the difference between hidden and absent rows.
  return result.ok && "key" in result
    ? {
        key: result.key,
        agentId: result.agentId,
        isCurrent,
      }
    : null;
}
