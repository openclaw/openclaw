import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionCatalogLocator,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import {
  allowProcessHomeFallback,
  createSessionCatalogRequestNodeSnapshot,
  listSessionCatalogProvider,
} from "./session-catalog-provider-access.js";
import { isSessionCatalogThreadVisible } from "./session-catalog-visibility.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export async function authorizeSessionCatalogThread(params: {
  access: "read" | "mutate";
  client: GatewayClient | null;
  context: GatewayRequestContext;
  provider: SessionCatalogProvider;
  request: SessionCatalogLocator & { agentId?: string };
  respond: RespondFn;
}): Promise<{ agentId: string; allowProcessHomeFallback: boolean } | null> {
  const resolvedAgent = resolveAgentIdOrRespondError({
    rawAgentId: params.request.agentId,
    respond: params.respond,
    cfg: params.context.getRuntimeConfig(),
    normalize: normalizeOptionalString,
  });
  if (!resolvedAgent) {
    return null;
  }
  const { agentId } = resolvedAgent;
  const allowHomeFallback = allowProcessHomeFallback(params.context.logGateway);
  const visible = await isSessionCatalogThreadVisible({
    access: params.access,
    allowProcessHomeFallback: allowHomeFallback,
    audience: params.provider.audience,
    client: params.client,
    context: params.context,
    fallbackAgentId: agentId,
    hostId: params.request.hostId,
    list: (request) => listSessionCatalogProvider(params.provider, { ...request, agentId }),
    listNodes: createSessionCatalogRequestNodeSnapshot(),
    ...(params.request.sourceHomeId ? { sourceHomeId: params.request.sourceHomeId } : {}),
    threadId: params.request.threadId,
  });
  if (visible) {
    return { agentId, allowProcessHomeFallback: allowHomeFallback };
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, "session catalog thread is not visible to this caller"),
  );
  return null;
}
