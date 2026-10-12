import type { ControlUiSessionPathTarget } from "@openclaw/session-url-contract/parse";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { withPreparedSessionResolve, type SessionsResolveResult } from "./sessions-resolve.js";

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
  let revision: object | undefined;
  const resolve = (p: SessionsResolveParams) =>
    withPreparedSessionResolve(
      {
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
      },
      (result) => {
        revision = projection.sharingRevision;
        return result;
      },
    );
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
        isCurrent: () =>
          revision !== undefined &&
          revision === projection.sharingRevision &&
          params.isCurrent?.() !== false,
      }
    : null;
}
