import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { isConversationToolAllowed } from "../agents/conversation-tool-policy-pipeline.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import type { SessionCapabilityLookup } from "../agents/subagents/spawn/subagent-session-store.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import { hasGatewayAdminScope } from "./server-methods/chat-origin-routing.js";
import { resolveChatSendCallerContext } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { resolveSessionSelectedModelRef } from "./session-utils-model-selection.js";

function denied(
  message = "The session's current tool policy does not allow this operation.",
): never {
  throw new SessionMutationAuthorizationChangedError(
    errorShape(ErrorCodes.FORBIDDEN, message, {
      details: { code: "SESSION_RESOURCE_TOOL_POLICY" },
    }),
  );
}

/** Session resource policy is independent of a request or an admitted model turn's lifetime. */
export async function prepareSessionResourceToolPolicy(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  target: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
  toolName: string;
}) {
  const projection = getSessionRowProjection(params.context);
  if (!projection) {
    denied();
  }
  await projection.prepareMembership();
  const query = { agentId: params.target.agentId, key: params.target.sessionKey };
  const original = projection.sharingTarget(query);
  if (!original) {
    denied();
  }
  let retired = false;
  const resolveCurrent = () => {
    if (retired || getSessionRowProjection(params.context) !== projection) {
      denied();
    }
    const current = projection.sharingTarget(query);
    if (
      !current ||
      current.storePath !== original.storePath ||
      current.entry.sessionId !== params.target.sessionId ||
      current.entry.lifecycleRevision !== params.target.lifecycleRevision
    ) {
      denied();
    }
    const config = params.context.getRuntimeConfig();
    const entry = current.entry;
    // Native ownership still uses plugin storage. A published, invalidatable ownership
    // view is required before this retained resource path can serve locked sessions.
    if (entry.modelSelectionLocked === true) {
      denied(
        "Session-scoped resources are unavailable for sessions with locked model selection. Administrator global access remains available.",
      );
    }
    const readEntry = (key: string) => {
      const parsed = parseAgentSessionKey(key);
      if (!parsed) {
        return undefined;
      }
      const related = projection.sharingTarget({
        key,
        agentId: parsed.agentId,
        ...(parsed.agentId === current.agentId ? { storePath: current.storePath } : {}),
      })?.entry;
      if (!related) {
        denied();
      }
      return related;
    };
    const store: SessionCapabilityLookup = {
      authoritative: true,
      get: readEntry,
      // Policy lineage is stored as canonical keys. An unresolved id must not open SQLite.
      getById: () => undefined,
    };
    const metadata = getGatewayPluginMetadataSnapshot();
    const model = resolveSessionSelectedModelRef({
      cfg: config,
      sessionKey: params.target.sessionKey,
      agentId: params.target.agentId,
      source: { entry, readSourceEntry: readEntry },
      manifestPlugins: metadata ?? [],
    });
    const sandbox = resolveSandboxRuntimeStatus({
      cfg: config,
      sessionKey: params.target.sessionKey,
      agentId: params.target.agentId,
      preparedSessionEntry: entry,
    });
    const caller = resolveChatSendCallerContext(params.client);
    const origin = sessionDeliveryOrigin(entry);
    const capability = resolveConversationCapabilityProfile({
      config,
      agentId: params.target.agentId,
      sessionKey: params.target.sessionKey,
      sessionId: entry.sessionId,
      preparedSessionEntry: { sessionKey: params.target.sessionKey, entry },
      preparedSessionCapabilityStore: store,
      spawnedBy: entry.spawnedBy,
      modelProvider: model.provider,
      modelId: model.model,
      pluginMetadataSnapshot: metadata,
      messageProvider: caller.Provider,
      messageChannel: caller.Surface,
      senderId: caller.SenderId,
      senderName: caller.SenderName,
      senderUsername: caller.SenderUsername,
      senderIsOwner: hasGatewayAdminScope(params.client),
      agentAccountId: origin?.accountId,
      groupId: entry.groupId,
      groupChannel: entry.groupChannel,
      groupSpace: entry.space,
      sandboxToolPolicy: sandbox.sandboxed ? sandbox.toolPolicy : undefined,
    });
    if (!isConversationToolAllowed(capability, params.toolName)) {
      denied();
    }
    return sandbox;
  };
  const assertCurrent = () => {
    try {
      return resolveCurrent();
    } catch (error) {
      // Restoring policy later cannot revive a resource captured under revoked authority.
      retired = true;
      throw error;
    }
  };
  const sandbox = assertCurrent();
  return {
    sandboxRequired: sandbox.sandboxRequired,
    sandboxed: sandbox.sandboxed,
    assertCurrent: () => {
      const current = assertCurrent();
      if (
        current.sandboxRequired !== sandbox.sandboxRequired ||
        current.sandboxed !== sandbox.sandboxed
      ) {
        retired = true;
        denied();
      }
    },
  };
}
