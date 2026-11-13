import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCatalogReadParams,
  type SessionsCatalogReadResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { projectSessionParticipant } from "../session-identity-projection.js";
import type { SessionActorProfileIdentity } from "../session-utils-contracts.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export async function readAuthorizedSessionCatalog(params: {
  request: SessionsCatalogReadParams;
  provider: SessionCatalogProvider;
  agentId: string;
  allowProcessHomeFallback: boolean;
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  isCurrent: () => boolean;
}): Promise<{ ok: true; page: SessionsCatalogReadResult } | { ok: false; error: ErrorShape }> {
  const { catalogId: _catalogId, ...providerRequest } = params.request;
  if (!params.isCurrent()) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.FORBIDDEN,
        "session catalog thread is not visible to this caller",
      ),
    };
  }
  const page = await params.provider.read({
    ...providerRequest,
    agentId: params.agentId,
    allowProcessHomeFallback: params.allowProcessHomeFallback,
  });
  // Source IO can outlive the caller's role grant; current policy owns data release.
  if (!params.isCurrent()) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.FORBIDDEN,
        "session catalog thread is not visible to this caller",
      ),
    };
  }
  const profiles = new Map<string, SessionActorProfileIdentity | undefined>();
  return {
    ok: true,
    page: {
      ...page,
      items: page.items.map((item) =>
        item.sender?.identity.type === "profile"
          ? Object.assign({}, item, {
              sender: projectSessionParticipant(item.sender.identity, profiles),
            })
          : item,
      ),
    },
  };
}
