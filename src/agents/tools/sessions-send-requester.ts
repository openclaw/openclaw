import { readAcpSessionMetaForEntry } from "../../acp/runtime/session-meta-readonly.js";
import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";
import type { AgentRouteBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { normalizeRouteBindingChannelId } from "../../routing/binding-scope.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  normalizeAccountId,
  normalizeAgentId,
} from "../../routing/session-key.js";
import { deriveSessionChatTypeFromKey } from "../../sessions/session-chat-type-shared.js";
import {
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
} from "../../sessions/session-key-utils.js";
import { isSubagentSessionFromEntry } from "../subagents/spawn/subagent-depth-policy.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

/** Prepare one original requester incarnation and its separately normalized reply address. */
export async function prepareSessionsSendRequester(params: {
  cfg: OpenClawConfig;
  opts?: SessionsSendToolOptions;
  effectiveRequesterKey: string;
  requesterAgentId: string;
  resolvedKey: string;
  mainKey: string;
}) {
  const { cfg, opts, effectiveRequesterKey, requesterAgentId, resolvedKey, mainKey } = params;
  const requesterSessionKey = opts?.agentSessionKey ? effectiveRequesterKey : undefined;
  const requesterSession = await resolveGatewaySessionStoreTargetInWorker({
    cfg,
    key: effectiveRequesterKey,
    agentId: requesterAgentId,
  });
  const requesterSessionEntry = requesterSession.store[requesterSession.canonicalKey];
  const requesterContinuationSession = opts?.agentSessionId
    ? {
        sessionId: opts.agentSessionId,
        lifecycleRevision: requesterSessionEntry?.lifecycleRevision,
      }
    : undefined;
  const requesterDeliveryGeneration: SessionDeliveryGeneration | undefined =
    requesterSessionEntry?.sessionId
      ? {
          agentId: requesterSession.agentId,
          storePath: requesterSession.storePath,
          sessionKey: requesterSession.canonicalKey,
          sessionId: opts?.agentSessionId ?? requesterSessionEntry.sessionId,
          lifecycleRevision: requesterSessionEntry.lifecycleRevision ?? null,
        }
      : undefined;
  const requesterIsSubagent = isSubagentSessionFromEntry(
    requesterSession.canonicalKey,
    requesterSessionEntry,
    readAcpSessionMetaForEntry({
      sessionKey: requesterSession.canonicalKey,
      agentId: requesterSession.agentId,
      cfg,
      entry: requesterSessionEntry,
    }),
  );
  const parsedRequesterSessionKey = parseAgentSessionKey(requesterSessionKey);
  let replyRequesterSessionKey = requesterSessionKey;
  // Preserve exact admitted incarnations. Legacy key-only callers still normalize
  // unthreaded DM reply addresses to their monitored main session.
  if (
    !opts?.agentSessionId &&
    requesterSessionKey &&
    parsedRequesterSessionKey &&
    requesterSessionKey !== resolvedKey &&
    !parsedRequesterSessionKey.rest.startsWith("cron:") &&
    !parsedRequesterSessionKey.rest.startsWith("hook:") &&
    !requesterIsSubagent &&
    deriveSessionChatTypeFromKey(requesterSessionKey) === "direct" &&
    !resolveSessionThreadInfo(requesterSessionKey).threadId
  ) {
    const requesterRouteBindings = cfg.bindings?.filter(
      (binding): binding is AgentRouteBinding => binding.type !== "acp",
    );
    const requesterDeliveryRoute = requesterRouteBindings?.length
      ? parseSessionDeliveryRoute(requesterSessionKey)
      : null;
    const bareRequesterPeerId = parsedRequesterSessionKey?.rest.startsWith("direct:")
      ? parsedRequesterSessionKey.rest.slice("direct:".length)
      : parsedRequesterSessionKey?.rest.startsWith("dm:")
        ? parsedRequesterSessionKey.rest.slice("dm:".length)
        : undefined;
    const requesterRouteChannel = requesterDeliveryRoute?.channel ?? opts?.agentChannel;
    const requesterRoutePeerId = requesterDeliveryRoute?.peerId ?? bareRequesterPeerId;
    const requesterRoute =
      requesterRouteBindings?.length && requesterRouteChannel && requesterRoutePeerId
        ? resolveAgentRoute({
            cfg,
            channel: requesterRouteChannel,
            accountId: requesterDeliveryRoute?.accountId,
            peer: { kind: "direct", id: requesterRoutePeerId },
          })
        : undefined;
    // Any configured route can transfer this peer to another agent. A key
    // without enough route facts must never be reassigned to guessed ownership.
    const hasUnresolvedRequesterRoute = Boolean(
      requesterRouteBindings?.length &&
      (!requesterRoute || requesterRoute.agentId !== parsedRequesterSessionKey?.agentId),
    );
    // Session keys can discard account, peer casing, team, guild, and roles.
    // Preserve the authenticated caller whenever any possible binding would
    // choose another agent or an isolated DM scope using those missing facts.
    const hasUnsafeRequesterDmBinding = Boolean(
      requesterRouteBindings?.some((binding) => {
        const effectiveDmScope = binding.session?.dmScope ?? cfg.session?.dmScope ?? "main";
        const isForeignAgent =
          normalizeAgentId(binding.agentId) !== parsedRequesterSessionKey?.agentId;
        if (!isForeignAgent && effectiveDmScope === "main") {
          return false;
        }
        if (
          requesterRouteChannel &&
          normalizeRouteBindingChannelId(binding.match.channel) !==
            normalizeRouteBindingChannelId(requesterRouteChannel)
        ) {
          return false;
        }
        const bindingAccountId = binding.match.accountId?.trim();
        if (
          requesterDeliveryRoute?.accountId &&
          bindingAccountId !== "*" &&
          normalizeAccountId(bindingAccountId) !==
            normalizeAccountId(requesterDeliveryRoute.accountId)
        ) {
          return false;
        }
        const peer = binding.match.peer;
        if (peer) {
          const peerId = peer.id.trim();
          if (
            peer.kind !== "direct" ||
            (peerId !== "*" && peerId.toLowerCase() !== requesterRoutePeerId?.trim().toLowerCase())
          ) {
            return false;
          }
        }
        return true;
      }),
    );
    const requesterDmScope =
      requesterRoute && requesterRoute.agentId === parsedRequesterSessionKey?.agentId
        ? (requesterRoute.dmScope ?? cfg.session?.dmScope ?? "main")
        : (cfg.session?.dmScope ?? "main");
    // Normalize only the reply address after exact-key visibility checks;
    // global/binding-isolated DMs keep their authenticated identity.
    if (
      requesterDmScope === "main" &&
      !hasUnresolvedRequesterRoute &&
      !hasUnsafeRequesterDmBinding
    ) {
      replyRequesterSessionKey = buildAgentMainSessionKey({
        agentId: parsedRequesterSessionKey.agentId,
        mainKey,
      });
    }
  }

  return {
    requesterSessionKey,
    requesterSession,
    requesterSessionEntry,
    requesterContinuationSession,
    requesterDeliveryGeneration,
    requesterIsSubagent,
    replyRequesterSessionKey,
  };
}
