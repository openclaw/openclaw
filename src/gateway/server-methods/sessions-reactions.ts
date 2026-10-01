import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  isReactionEmoji,
  validateSessionReactionsListParams,
  validateSessionReactionsSetParams,
  type MessageReactionSummary,
  type SessionReactionMirror,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveChannelAccount } from "../../channels/account-resolution.js";
import {
  createMessageActionDiscoveryContext,
  resolveCurrentChannelMessageToolDiscoveryAdapter,
  resolveMessageActionDiscoveryForPlugin,
} from "../../channels/plugins/message-action-discovery.js";
import {
  setSessionReaction,
  SessionReactionLimitError,
  SessionReactionMessageMissingError,
} from "../../config/sessions/session-reaction-store.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isConfiguredChannel } from "../../infra/outbound/channel-selection.js";
import { resolveMessageActionOutcome } from "../../infra/outbound/message-action-contracts.js";
import { getRuntimeVisibleChannelPlugin } from "../../infra/outbound/runtime-visible-channels.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { isAccountEnabled } from "../../shared/account-enabled.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import {
  readSessionReactionsAsync,
  readSessionMessageByIdAsync,
  readSessionConversationBindingAsync,
} from "../session-transcript-readers.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import {
  requireSuggestionTarget,
  requireVisibleSuggestionRole,
} from "./sessions-suggestions-access.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

type ReactionTarget = NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
type ReactionAuthorization = {
  client: GatewayClient | null;
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  target: ReactionTarget;
};

function authorizeSessionReaction(params: ReactionAuthorization) {
  const role = resolveSessionSharingRole(params);
  const cap = operatorSessionCap(params.client, params.cfg);
  if (cap === "none") {
    return errorShape(ErrorCodes.FORBIDDEN, "your operator role does not permit session reactions");
  }
  if (cap === "view" && role === "viewer") {
    return errorShape(ErrorCodes.FORBIDDEN, "your operator role permits viewing sessions only");
  }
  const denied = authorizeSessionSharingTarget(params);
  return denied && !(resolveSessionVisibility(params.target.entry) === "suggest" && cap !== "view")
    ? denied
    : null;
}

function reactionScope(target: ReactionTarget) {
  return { agentId: target.agentId, sessionKey: target.storeKey, storePath: target.storePath };
}

// A channel holds one bot reaction per emoji for all Control UI reactors. Mirrors
// for one message and emoji run in local commit order, so an older add can never
// land after a newer remove and leave the channel out of step with the store.
const mirrorQueues = new Map<string, Promise<SessionReactionMirror>>();

function enqueueMirror(
  key: string,
  task: () => Promise<SessionReactionMirror>,
): Promise<SessionReactionMirror> {
  const run = (mirrorQueues.get(key) ?? Promise.resolve()).then(task, task);
  mirrorQueues.set(key, run);
  const release = () => {
    if (mirrorQueues.get(key) === run) {
      mirrorQueues.delete(key);
    }
  };
  void run.then(release, release);
  return run;
}

type MirrorTransport = { channel: string; conversationRef: string; messageId: string };

/** Commit-time mirror decision; skips never wait behind in-flight dispatches. */
function resolveMirrorTransport(
  message: Record<string, unknown>,
  remove: boolean,
  remainingReactors: number,
): { skipped: SessionReactionMirror } | { transport: MirrorTransport } {
  if (message.role === "assistant") {
    return {
      skipped: {
        status: "skipped",
        reason: "assistant reply has no persisted delivered channel message id",
      },
    };
  }
  const transport = asOptionalRecord(asOptionalRecord(message["__openclaw"])?.transport);
  if (
    typeof transport?.channel !== "string" ||
    typeof transport.conversationRef !== "string" ||
    typeof transport.messageId !== "string"
  ) {
    return { skipped: { status: "skipped", reason: "message has no source channel transport" } };
  }
  // The bot reaction appears with the first reactor and leaves with the last.
  if (remove ? remainingReactors > 0 : remainingReactors > 1) {
    return {
      skipped: { status: "skipped", reason: "channel reaction still stands for other reactors" },
    };
  }
  return {
    transport: {
      channel: transport.channel,
      conversationRef: transport.conversationRef,
      messageId: transport.messageId,
    },
  };
}

async function mirrorReaction(params: {
  context: GatewayRequestContext;
  target: ReactionTarget;
  transport: MirrorTransport;
  emoji: string;
  remove: boolean;
  assertCurrent: () => void;
}): Promise<SessionReactionMirror> {
  const { transport } = params;
  const scope = { ...reactionScope(params.target), sessionId: params.target.entry.sessionId };
  const cfg = params.context.getRuntimeConfig();
  // Start capture now and reserve commit order before yielding to another mutation.
  const captured = readSessionConversationBindingAsync(scope, transport.conversationRef).then(
    (conversation) => ({ ok: true as const, conversation }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return enqueueMirror(
    [
      params.target.agentId,
      params.target.storeKey,
      params.target.entry.sessionId,
      transport.conversationRef,
      transport.messageId,
      params.emoji,
    ].join("\0"),
    async () => {
      try {
        const resolved = await captured;
        if (!resolved.ok) {
          throw resolved.error;
        }
        params.assertCurrent();
        const conversation = resolved.conversation;
        if (!conversation || conversation.channel !== transport.channel) {
          return { status: "skipped", reason: "source conversation is unavailable" };
        }
        const channel = conversation.channel;
        if (!isConfiguredChannel(cfg, channel)) {
          return { status: "skipped", reason: "source channel is not configured or enabled" };
        }
        // The mirror reacts inside the message's own conversation, so it uses the
        // current-channel discovery; the cross-channel schema-safe list excludes
        // every channel whose react params are current-channel-only.
        const discovery = resolveCurrentChannelMessageToolDiscoveryAdapter(channel);
        if (
          !discovery ||
          !resolveMessageActionDiscoveryForPlugin({
            pluginId: discovery.pluginId,
            actions: discovery.actions,
            context: createMessageActionDiscoveryContext({
              cfg,
              channel,
              accountId: conversation.accountId,
              agentId: params.target.agentId,
              sessionKey: params.target.canonicalKey,
              sessionId: params.target.entry.sessionId,
              currentChannelId: conversation.nativeChannelId,
              currentMessageId: transport.messageId,
              currentThreadTs: conversation.threadId,
            }),
            includeActions: true,
          }).actions.includes("react")
        ) {
          return { status: "skipped", reason: "source channel does not support reactions" };
        }
        const plugin = getRuntimeVisibleChannelPlugin(channel);
        if (!plugin) {
          return { status: "skipped", reason: "source channel is unavailable" };
        }
        const account = await resolveChannelAccount({
          plugin,
          cfg,
          accountId: conversation.accountId,
        });
        if (
          !(plugin.config.isEnabled?.(account, cfg) ?? isAccountEnabled(account)) ||
          !((await plugin.config.isConfigured?.(account, cfg)) ?? true)
        ) {
          return {
            status: "skipped",
            reason: "source channel account is not configured or enabled",
          };
        }
        const { runMessageAction } = await import("../../infra/outbound/message-action-runner.js");
        const assertCurrent = () => {
          params.assertCurrent();
          if (params.context.getRuntimeConfig() !== cfg) {
            throw new Error("channel configuration changed before reaction delivery");
          }
        };
        const current = await readSessionConversationBindingAsync(scope, transport.conversationRef);
        if (
          !current ||
          current.channel !== conversation.channel ||
          current.accountId !== conversation.accountId ||
          current.target !== conversation.target ||
          current.threadId !== conversation.threadId ||
          current.nativeChannelId !== conversation.nativeChannelId
        ) {
          return { status: "failed", reason: "source conversation changed before delivery" };
        }
        // The registry has no synchronous worker read: binding is the last awaited
        // check before handoff; the adapter guard retains live reactor/session/config checks.
        assertCurrent();
        const outcome = resolveMessageActionOutcome(
          await runMessageAction({
            cfg,
            action: "react",
            agentId: params.target.agentId,
            sessionKey: params.target.canonicalKey,
            sessionId: params.target.entry.sessionId,
            // A person asked for this reaction from the Control UI; like the CLI it
            // is an operator action, not a model-delegated conversation read.
            conversationReadOrigin: "direct-operator",
            assertDirectAdapterHandoff: assertCurrent,
            params: {
              channel,
              to: conversation.target,
              accountId: conversation.accountId,
              ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
              messageId: transport.messageId,
              emoji: params.emoji,
              remove: params.remove,
            },
          }),
        );
        if (!outcome.ok) {
          throw new Error(outcome.error);
        }
        return { status: "delivered" };
      } catch (error) {
        const reason = formatErrorMessage(error);
        params.context.logGateway.warn(`Control UI reaction mirror failed: ${reason}`);
        return { status: "failed", reason };
      }
    },
  );
}

export const sessionReactionHandlers: GatewayRequestHandlers = {
  "session.reactions.list": defineValidatedGatewayHandler(
    "session.reactions.list",
    validateSessionReactionsListParams,
    async ({ params, respond, client, context, hasCurrentClientAuthority }) => {
      const target = requireSuggestionTarget({ client, context, ...params, respond });
      if (!target) {
        return;
      }
      const cfg = (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)();
      if (
        requireVisibleSuggestionRole({
          client,
          cfg,
          sessionKey: params.sessionKey,
          target,
          respond,
        }) === null
      ) {
        return;
      }
      const reactions = await readSessionReactionsAsync({
        ...reactionScope(target),
        sessionId: target.entry.sessionId,
      });
      if (
        hasCurrentClientAuthority?.() === false ||
        client?.invalidated ||
        client?.connectionSignal?.aborted
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "reaction reader authority changed"),
        );
        return;
      }
      const current = requireSuggestionTarget({ client, context, ...params, respond });
      if (!current) {
        return;
      }
      if (
        current.storePath !== target.storePath ||
        current.storeKey !== target.storeKey ||
        current.agentId !== target.agentId ||
        current.entry.sessionId !== target.entry.sessionId
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "session changed during reaction read"),
        );
        return;
      }
      if (
        requireVisibleSuggestionRole({
          client,
          cfg: (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)(),
          sessionKey: params.sessionKey,
          target: current,
          respond,
        }) === null
      ) {
        return;
      }
      respond(true, { sessionId: target.entry.sessionId, reactions });
    },
  ),
  "session.reactions.set": defineValidatedGatewayHandler(
    "session.reactions.set",
    validateSessionReactionsSetParams,
    async ({ params, respond, client, context, hasCurrentClientAuthority }) => {
      const target = requireSuggestionTarget({ client, context, ...params, respond });
      if (!target) {
        return;
      }
      const cfg = (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)();
      if (
        requireVisibleSuggestionRole({
          client,
          cfg,
          sessionKey: params.sessionKey,
          target,
          respond,
        }) === null
      ) {
        return;
      }
      const denied = authorizeSessionReaction({ client, cfg, target });
      if (denied) {
        respond(false, undefined, denied);
        return;
      }
      const actor = gatewayClientSessionCreator(client);
      if (!actor) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "identified reaction author required"),
        );
        return;
      }
      if (!isReactionEmoji(params.emoji)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "one emoji grapheme is required"),
        );
        return;
      }
      const scope = reactionScope(target);
      const message = asOptionalRecord(
        (
          await readSessionMessageByIdAsync(
            {
              ...scope,
              sessionId: target.entry.sessionId,
            },
            params.messageId,
            {
              currentOnly: true,
              maxBytes: Number.MAX_SAFE_INTEGER,
              allowResetArchiveFallback: false,
            },
          )
        ).message,
      );
      if (!message || (message.role !== "user" && message.role !== "assistant")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown message"));
        return;
      }
      const assertCurrent = () => {
        const currentCfg = (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)();
        const current = resolveSessionSharingTarget({
          cfg: currentCfg,
          sessionKey: params.sessionKey,
          agentId: target.agentId,
        });
        if (
          hasCurrentClientAuthority?.() === false ||
          client?.invalidated ||
          client?.connectionSignal?.aborted ||
          !current ||
          current.storePath !== target.storePath ||
          current.entry.sessionId !== target.entry.sessionId ||
          authorizeIncognitoSessionTarget({
            client,
            sessionKey: params.sessionKey,
            target: current,
          }) ||
          authorizeSessionReaction({ client, cfg: currentCfg, target: current }) ||
          gatewayClientSessionCreator(client)?.id !== actor.id
        ) {
          throw new Error("reaction author or session authority changed");
        }
      };
      let write: { reactions: MessageReactionSummary[]; changed: boolean };
      try {
        assertCurrent();
        write = setSessionReaction(scope, {
          messageId: params.messageId,
          emoji: params.emoji,
          identityId: actor.id,
          identityLabel: actor.label,
          remove: params.remove,
          expectedSessionId: target.entry.sessionId,
        });
        assertCurrent();
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            error instanceof SessionReactionLimitError
              ? "reaction limit reached"
              : error instanceof SessionReactionMessageMissingError
                ? "unknown message"
                : formatErrorMessage(error),
          ),
        );
        return;
      }
      const { reactions } = write;
      // A retry or double click must not announce a change that did not happen.
      if (!write.changed) {
        respond(true, {
          messageId: params.messageId,
          reactions,
          mirror: { status: "skipped", reason: "reaction already in that state" },
        });
        return;
      }
      const action = params.remove ? "removed" : "added";
      context.broadcast(
        "session.reaction",
        {
          sessionKey: target.canonicalKey,
          agentId: target.agentId,
          sessionId: target.entry.sessionId,
          messageId: params.messageId,
          emoji: params.emoji,
          action,
          actor,
          reactions,
        },
        {
          sessionKeys: [
            ...new Set([params.sessionKey, target.canonicalKey, target.storeKey]),
          ].toSorted(),
          agentId: target.agentId,
        },
      );
      const metadata = asOptionalRecord(message["__openclaw"]);
      const author =
        message.role === "assistant"
          ? "assistant"
          : ([metadata?.senderName, metadata?.senderUsername, metadata?.senderId].find(
              (label): label is string => typeof label === "string" && label.trim().length > 0,
            ) ?? "user");
      enqueueSystemEvent(
        `Control UI reaction ${action}: ${params.emoji} by ${actor.label ?? actor.id} on msg ${params.messageId} from ${author}`,
        // Like board notices, let the published store resolver supply the current
        // physical store path: a logical path here fails the freshness guard on
        // symlinked state directories and the event is dropped silently.
        withSystemEventOwner(
          {
            sessionKey: target.canonicalKey,
            contextKey: `control-ui:reaction:${action}:${params.messageId}:${actor.id}:${params.emoji}:${randomUUID()}`,
          },
          target.agentId,
        ),
      );
      const decision = resolveMirrorTransport(
        message,
        params.remove === true,
        reactions.find((reaction) => reaction.emoji === params.emoji)?.count ?? 0,
      );
      // Enqueue before any await so queue order is commit order.
      const mirror =
        "skipped" in decision
          ? decision.skipped
          : await mirrorReaction({
              context,
              target,
              transport: decision.transport,
              emoji: params.emoji,
              remove: params.remove === true,
              assertCurrent,
            });
      respond(true, { messageId: params.messageId, reactions, mirror });
    },
  ),
};
