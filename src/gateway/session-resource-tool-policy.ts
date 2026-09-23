import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { isConversationToolAllowed } from "../agents/conversation-tool-policy-pipeline.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import type { SessionCapabilityLookup } from "../agents/subagents/spawn/subagent-session-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import { hasGatewayAdminScope } from "./server-methods/chat-origin-routing.js";
import { resolveChatSendCallerContext } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import type { SessionRowProjection } from "./session-row-projection.js";
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

/** Evaluate canonical tool policy using facts already prepared by the session authority. */
export function resolveSessionResourceToolPolicy(params: {
  config: OpenClawConfig;
  client: GatewayClient | null;
  current: NonNullable<ReturnType<SessionRowProjection["sharingTarget"]>>;
  readSessionEntry: (query: {
    key: string;
    agentId: string;
    storePath?: string;
  }) => SessionEntry | undefined;
  toolName: string;
}) {
  const { config, current } = params;
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
    const related = params.readSessionEntry({
      key,
      agentId: parsed.agentId,
      ...(parsed.agentId === current.agentId ? { storePath: current.storePath } : {}),
    });
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
    sessionKey: current.canonicalKey,
    agentId: current.agentId,
    source: { entry, readSourceEntry: readEntry },
    manifestPlugins: metadata ?? [],
  });
  const sandbox = resolveSandboxRuntimeStatus({
    cfg: config,
    sessionKey: current.canonicalKey,
    agentId: current.agentId,
    preparedSessionEntry: entry,
  });
  const caller = resolveChatSendCallerContext(params.client);
  const origin = sessionDeliveryOrigin(entry);
  const capability = resolveConversationCapabilityProfile({
    config,
    agentId: current.agentId,
    sessionKey: current.canonicalKey,
    sessionId: entry.sessionId,
    preparedSessionEntry: { sessionKey: current.canonicalKey, entry },
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
  return { sandboxRequired: sandbox.sandboxRequired, sandboxed: sandbox.sandboxed };
}
