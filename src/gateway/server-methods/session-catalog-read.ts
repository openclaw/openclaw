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
import {
  isPublishedCatalogVisible,
  resolveSessionCatalogVisibility,
} from "./session-catalog-visibility.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export async function readAuthorizedSessionCatalog(params: {
  request: SessionsCatalogReadParams;
  provider: SessionCatalogProvider;
  agentId: string;
  allowProcessHomeFallback: boolean;
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
}): Promise<{ ok: true; page: SessionsCatalogReadResult } | { ok: false; error: ErrorShape }> {
  const { catalogId: _catalogId, ...providerRequest } = params.request;
  const page = await params.provider.read({
    ...providerRequest,
    agentId: params.agentId,
    allowProcessHomeFallback: params.allowProcessHomeFallback,
  });
  // Source IO can outlive the caller's role grant; current policy owns data release.
  if (
    params.provider.audience === "session-viewers" &&
    !isPublishedCatalogVisible(
      resolveSessionCatalogVisibility(params.client, params.context.getRuntimeConfig()),
    )
  ) {
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
