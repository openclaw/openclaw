import {
  ErrorCodes,
  errorShape,
  validateChatMetadataParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ChatMetadataParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { preparePersonalModelAccountSelection } from "./users-model-account-access.js";
import { resolveAuthenticatedProfileId } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";

/** Resolve saved-session grants or capture a new draft's current human authority. */
export function resolveChatMetadataReadParams(
  options: Pick<GatewayRequestHandlerOptions, "respond" | "context" | "client" | "signal">,
  params: ChatMetadataParams,
): ChatMetadataReadParams | undefined {
  const { respond, context, client, signal } = options;
  const cfg = context.getRuntimeConfig();
  if (params.sessionKey) {
    const requested = resolveRequestedSessionAgentId(
      cfg,
      params.sessionKey,
      normalizeOptionalChatText(params.agentId),
    );
    if (!requested.ok) {
      respond(false, undefined, requested.error);
      return undefined;
    }
    // Persisted session state owns account pins; a caller cannot replace them with a draft id.
    const session = loadGatewaySessionEntryReadOnly(params.sessionKey, {
      agentId: requested.agentId,
      projection: "list",
    });
    return {
      agentId: resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: session.cfg,
        agentId: requested.agentId,
      }),
      sessionKey: session.canonicalKey,
      sessionEntry: session.entry,
      requesterProfileId: resolveAuthenticatedProfileId(client),
    };
  }
  const resolved = resolveAgentIdOrRespondError({
    rawAgentId: params.agentId,
    respond,
    cfg,
    normalize: (id) => (typeof id === "string" && id.trim() ? normalizeAgentId(id) : undefined),
  });
  if (!resolved) {
    return undefined;
  }
  const draftAccountSelection = params.authProfileId
    ? preparePersonalModelAccountSelection(
        { client, context, signal },
        params.authProfileId,
        "operator.read",
      )
    : undefined;
  return {
    agentId: resolved.agentId,
    requesterProfileId: draftAccountSelection?.owner ?? resolveAuthenticatedProfileId(client),
    ...(draftAccountSelection ? { draftAccountSelection } : {}),
  };
}

export async function handleChatMetadataRequest(
  options: GatewayRequestHandlerOptions,
): Promise<void> {
  const { params, respond, context } = options;
  if (!assertValidParams(params, validateChatMetadataParams, "chat.metadata", respond)) {
    return;
  }
  try {
    const scope = resolveChatMetadataReadParams(options, params);
    if (!scope) {
      return;
    }
    const metadata = await context.readChatMetadata(scope);
    scope.draftAccountSelection?.assertCurrent();
    respond(true, metadata);
  } catch (error) {
    if (!(error instanceof ModelAccountConnectAuthorityError)) {
      throw error;
    }
    respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
  }
}
