import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  isReactionEmoji,
  validateSessionReactionsListParams,
  validateSessionReactionsSetParams,
  type SessionReactionMirror,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveChannelAccount } from "../../channels/account-resolution.js";
import {
  createMessageActionDiscoveryContext,
  resolveCurrentChannelMessageToolDiscoveryAdapter,
  resolveMessageActionDiscoveryForPluginAsync,
} from "../../channels/plugins/message-action-discovery.js";
import {
  setSessionReactionAsync,
  SessionReactionLimitError,
  SessionReactionMessageMissingError,
} from "../../config/sessions/session-reaction-store.js";
import type { SessionReactionWrite } from "../../config/sessions/session-reaction-store.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isConfiguredChannel } from "../../infra/outbound/channel-selection.js";
import { resolveMessageActionOutcome } from "../../infra/outbound/message-action-contracts.js";
import { getRuntimeVisibleChannelPlugin } from "../../infra/outbound/runtime-visible-channels.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { enqueueKeyedTask } from "../../plugin-sdk/keyed-async-queue.js";
import { isAccountEnabled } from "../../shared/account-enabled.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  readSessionReactionsAsync,
  readSessionMessageByIdAsync,
  readSessionConversationBindingAsync,
} from "../session-transcript-readers.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { withSessionReactionAccess } from "./sessions-reactions-access.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

function reactionScope(target: SessionSharingTarget) {
  return { agentId: target.agentId, sessionKey: target.storeKey, storePath: target.storePath };
}

// Mirrors run in local commit order per message and channel reaction slot, so
// an older add can never land after a newer remove and leave the channel out of
// step with the store. Single-slot channels share the queue across all emoji.
const mirrorQueues = new Map<string, Promise<void>>();

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
  target: SessionSharingTarget;
  transport: MirrorTransport;
  newestRemainingEmoji: string | undefined;
  emoji: string;
  remove: boolean;
  assertCurrent: () => void;
}): Promise<SessionReactionMirror> {
  try {
    const { transport } = params;
    const plugin = getRuntimeVisibleChannelPlugin(transport.channel);
    const singleSlot = plugin?.capabilities.reactionSlots === "single";
    const replacement = singleSlot && params.remove ? params.newestRemainingEmoji : undefined;
    const scope = { ...reactionScope(params.target), sessionId: params.target.entry.sessionId };
    const cfg = params.context.getRuntimeConfig();
    // Start capture now and reserve commit order before yielding to another mutation.
    const captured = readSessionConversationBindingAsync(scope, transport.conversationRef).then(
      (conversation) => ({ ok: true as const, conversation }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    return await enqueueKeyedTask({
      tails: mirrorQueues,
      key: [
        params.target.agentId,
        params.target.storeKey,
        params.target.entry.sessionId,
        transport.conversationRef,
        transport.messageId,
        singleSlot ? "" : params.emoji,
      ].join("\0"),
      task: async () => {
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
          !(
            await resolveMessageActionDiscoveryForPluginAsync({
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
            })
          ).actions.includes("react")
        ) {
          return { status: "skipped", reason: "source channel does not support reactions" };
        }
        params.assertCurrent();
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
            onPlatformSendDispatch: async () => {
              const current = await readSessionConversationBindingAsync(
                scope,
                transport.conversationRef,
              );
              if (
                !current ||
                current.channel !== conversation.channel ||
                current.accountId !== conversation.accountId ||
                current.target !== conversation.target ||
                current.threadId !== conversation.threadId ||
                current.nativeChannelId !== conversation.nativeChannelId
              ) {
                throw new Error("source conversation changed before delivery");
              }
            },
            assertDirectAdapterHandoff: assertCurrent,
            params: {
              channel,
              to: conversation.target,
              accountId: conversation.accountId,
              ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
              messageId: transport.messageId,
              emoji: replacement ?? params.emoji,
              remove: params.remove && !replacement,
            },
          }),
        );
        if (!outcome.ok) {
          throw new Error(outcome.error);
        }
        return { status: "delivered" };
      },
    });
  } catch (error) {
    const reason = formatErrorMessage(error);
    params.context.logGateway.warn(`Control UI reaction mirror failed: ${reason}`);
    return { status: "failed", reason };
  }
}

export const sessionReactionHandlers: GatewayRequestHandlers = {
  "session.reactions.list": defineValidatedGatewayHandler(
    "session.reactions.list",
    validateSessionReactionsListParams,
    async ({ params, respond, client, context, hasCurrentClientAuthority }) => {
      await withSessionReactionAccess(
        { ...params, client, context, respond, hasCurrentClientAuthority, write: false },
        async ({ target, assertCurrent }) => {
          const reactions = await readSessionReactionsAsync({
            ...reactionScope(target),
            sessionId: target.entry.sessionId,
          });
          assertCurrent();
          respond(true, { sessionId: target.entry.sessionId, reactions });
        },
      );
    },
  ),
  "session.reactions.set": defineValidatedGatewayHandler(
    "session.reactions.set",
    validateSessionReactionsSetParams,
    async ({ params, respond, client, context, hasCurrentClientAuthority }) => {
      await withSessionReactionAccess(
        { ...params, client, context, respond, hasCurrentClientAuthority, write: true },
        async ({ target, assertCurrent }) => {
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
          assertCurrent();
          if (!message || (message.role !== "user" && message.role !== "assistant")) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown message"));
            return;
          }
          let write: SessionReactionWrite;
          try {
            assertCurrent();
            write = await setSessionReactionAsync(scope, {
              messageId: params.messageId,
              emoji: params.emoji,
              identityId: actor.id,
              identityLabel: actor.label,
              remove: params.remove,
              expectedSessionId: target.entry.sessionId,
              assertCurrent,
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
                  newestRemainingEmoji: write.newestRemainingEmoji,
                  emoji: params.emoji,
                  remove: params.remove === true,
                  assertCurrent,
                });
          respond(true, { messageId: params.messageId, reactions, mirror });
        },
      );
    },
  ),
};
