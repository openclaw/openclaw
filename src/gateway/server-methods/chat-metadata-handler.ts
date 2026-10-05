import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatMetadataParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ChatMetadataParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { readUserProfileAliasRevision } from "../../state/user-profile-events.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect-errors.js";
import { prepareOperatorModelPresentation } from "../operator-model-presentation.js";
import { readOperatorRolePolicyRevision } from "../operator-role-policy.js";
import { SESSION_READ_SCOPE } from "../operator-scopes.js";
import { projectModelFastModeCatalog } from "../session-fast-mode-presentation.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { hasSessionReadAccessChanged, hiddenSessionNotFound } from "../session-sharing-policy.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { retainGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import {
  chatMetadataSessionFields,
  type ChatMetadataReadParams,
} from "./chat-metadata-contract.js";
import { createPreparedReadHandler } from "./prepared-read.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { preparePersonalModelAccountSelection } from "./users-model-account-access.js";
import { prepareAuthenticatedProfile } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";

/** Resolve saved-session grants or capture a new draft's current human authority. */
export async function resolveChatMetadataReadParams(
  options: GatewayRequestHandlerOptions,
  params: ChatMetadataParams,
  draftAccountSelection?: UserModelAccountSelection,
): Promise<ChatMetadataReadParams | undefined> {
  const { respond, context, client, signal } = options;
  const cfg = context.getRuntimeConfig();
  draftAccountSelection?.assertCurrent();
  const requester = await prepareAuthenticatedProfile(options);
  requester.assertCurrent();
  // Session mutations are checked against the retained target before publication.
  const roleRevision = readOperatorRolePolicyRevision();
  const aliasRevision = readUserProfileAliasRevision();
  const profileInput = client?.authenticatedUserProfile?.profileId;
  const userInput = client?.authenticatedUserId;
  const isRequestCurrent = () =>
    !signal?.aborted &&
    readOperatorRolePolicyRevision() === roleRevision &&
    readUserProfileAliasRevision() === aliasRevision &&
    client?.authenticatedUserProfile?.profileId === profileInput &&
    client?.authenticatedUserId === userInput;
  const assertRequestCurrent = () => {
    if (!isRequestCurrent() || context.getRuntimeConfig() !== cfg) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Chat metadata access changed while preparing its metadata. Retry the request.",
      );
    }
    requester.assertCurrent();
    draftAccountSelection?.assertCurrent();
  };
  if (params.sessionKey) {
    const sessionKey = params.sessionKey;
    const requested = resolveRequestedSessionAgentId(
      cfg,
      params.sessionKey,
      normalizeOptionalString(params.agentId),
    );
    if (!requested.ok) {
      respond(false, undefined, requested.error);
      return undefined;
    }
    // Persisted session state owns account pins; a caller cannot replace them with a draft id.
    const requesterProfileId = requester.profileId;
    const session = retainGatewaySessionEntryReadOnly(
      params.sessionKey,
      requested.agentId,
      (previous, current) =>
        !hasSessionReadAccessChanged(previous, current) &&
        chatMetadataSessionFields.every((field) =>
          isDeepStrictEqual(previous[field], current[field]),
        ),
    );
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
  return {
    agentId: resolved.agentId,
    requesterProfileId: draftAccountSelection?.owner ?? requester.profileId,
    isCurrent: isRequestCurrent,
    assertCurrent: assertRequestCurrent,
    ...(draftAccountSelection ? { draftAccountSelection } : {}),
  };
}

export const handleChatMetadataRequest = createPreparedReadHandler(
  async (options) => {
    const { params, respond: respondToCaller, context, client } = options;
    if (!assertValidParams(params, validateChatMetadataParams, "chat.metadata", respondToCaller)) {
      return undefined;
    }
    let scope: ChatMetadataReadParams | undefined;
    try {
      const draftAccountSelection =
        !params.sessionKey && params.authProfileId
          ? await preparePersonalModelAccountSelection(
              options,
              params.authProfileId,
              SESSION_READ_SCOPE,
            )
          : undefined;
      scope = await resolveChatMetadataReadParams(options, params, draftAccountSelection);
      if (!scope) {
        return undefined;
      }
      if (params.includeModels === false) {
        scope.includeModels = false;
      }
      const readScope = scope;
      const assertCurrent = () => {
        readScope.draftAccountSelection?.assertCurrent();
        readScope.assertCurrent?.();
      };
      assertCurrent();
      return {
        assertCurrent,
        release: readScope.release,
        run: async (respond) => {
          const metadata = await context.readChatMetadata(readScope);
          assertCurrent();
          const cfg = context.getRuntimeConfig();
          const policy =
            metadata.models &&
            prepareOperatorModelPresentation({
              cfg,
              policyConfig: context.getCommittedRuntimeConfig?.() ?? cfg,
              client,
            })?.forAgent(readScope.agentId, metadata.models);
          respond(
            true,
            projectModelFastModeCatalog(policy ? policy.metadata(metadata) : metadata, client),
          );
        },
      };
    } catch (error) {
      scope?.release?.();
      throw error;
    }
  },
  (error, { respond }) => {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      respond(false, undefined, error.error);
      return;
    }
    if (!(error instanceof ModelAccountConnectAuthorityError)) {
      throw error;
    }
    respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
  },
);
