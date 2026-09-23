import {
  ErrorCodes,
  errorShape,
  validateChatMetadataParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ChatMetadataParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { prepareOperatorModelPresentation } from "../operator-model-presentation.js";
import { SESSION_READ_SCOPE } from "../operator-scopes.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { hiddenSessionNotFound } from "../session-sharing-policy.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { retainGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
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
  const accessRevision = readGatewayAccessRevision();
  const profileInput = client?.authenticatedUserProfile?.profileId;
  const userInput = client?.authenticatedUserId;
  const isRequestCurrent = () =>
    !signal?.aborted &&
    readGatewayAccessRevision() === accessRevision &&
    client?.authenticatedUserProfile?.profileId === profileInput &&
    client?.authenticatedUserId === userInput;
  const assertRequestCurrent = () => {
    if (!isRequestCurrent() || context.getRuntimeConfig() !== cfg) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Chat metadata access changed while preparing its metadata. Retry the request.",
      );
    }
  };
  if (params.sessionKey) {
    const sessionKey = params.sessionKey;
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
    const requesterProfileId = resolveAuthenticatedProfileId(client);
    const session = retainGatewaySessionEntryReadOnly(params.sessionKey, requested.agentId);
    const isCurrent = () => isRequestCurrent() && session.isCurrent();
    const assertVisible = () => {
      const visible = createSessionListEntryFilter({
        client,
        cfg: (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)(),
      });
      if (
        session.entry &&
        visible?.(session.legacyKey ?? session.canonicalKey, session.entry) === false
      ) {
        throw new SessionMutationAuthorizationChangedError(hiddenSessionNotFound(sessionKey));
      }
    };
    try {
      assertVisible();
      return {
        agentId: resolveSessionAgentId({
          sessionKey: params.sessionKey,
          config: session.cfg,
          agentId: requested.agentId,
        }),
        sessionKey: session.canonicalKey,
        storePath: session.readSource?.path ?? session.storePath,
        sessionEntry: session.entry,
        isCurrent,
        assertCurrent: () => {
          assertVisible();
          assertRequestCurrent();
          if (!session.isCurrentAtResponse()) {
            throw new PreparedModelRuntimePublicationSupersededError(
              "Session changed while preparing its metadata. Retry the request.",
            );
          }
        },
        release: session.release,
        requesterProfileId,
      };
    } catch (error) {
      session.release();
      throw error;
    }
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
  assertRequestCurrent();
  const draftAccountSelection = params.authProfileId
    ? preparePersonalModelAccountSelection(
        { client, context, signal },
        params.authProfileId,
        SESSION_READ_SCOPE,
      )
    : undefined;
  return {
    agentId: resolved.agentId,
    requesterProfileId: draftAccountSelection?.owner ?? resolveAuthenticatedProfileId(client),
    isCurrent: isRequestCurrent,
    assertCurrent: assertRequestCurrent,
    ...(draftAccountSelection ? { draftAccountSelection } : {}),
  };
}

export async function handleChatMetadataRequest(
  options: GatewayRequestHandlerOptions,
): Promise<void> {
  const { params, respond, context, client } = options;
  if (!assertValidParams(params, validateChatMetadataParams, "chat.metadata", respond)) {
    return;
  }
  let scope: ChatMetadataReadParams | undefined;
  try {
    scope = resolveChatMetadataReadParams(options, params);
    if (!scope) {
      return;
    }
    const metadata = await context.readChatMetadata(scope);
    scope.draftAccountSelection?.assertCurrent();
    scope.assertCurrent?.();
    const cfg = context.getRuntimeConfig();
    const policy = prepareOperatorModelPresentation({
      cfg,
      policyConfig: context.getCommittedRuntimeConfig?.() ?? cfg,
      client,
    })?.forAgent(scope.agentId, metadata.models);
    respond(true, policy ? policy.metadata(metadata) : metadata);
  } catch (error) {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      respond(false, undefined, error.error);
      return;
    }
    if (!(error instanceof ModelAccountConnectAuthorityError)) {
      throw error;
    }
    respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
  } finally {
    scope?.release?.();
  }
}
