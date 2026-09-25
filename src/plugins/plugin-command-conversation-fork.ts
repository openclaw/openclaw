import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { matchesActiveSessionBindingSnapshot } from "../infra/outbound/session-binding-identity.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type ConversationRef,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import type { PluginCommandConversationForkHost } from "./plugin-command.types.js";

const METADATA_KEY = "conversationFork";

type ForkMetadata = {
  version: 1;
  operationId: string;
  sourceSessionKey: string;
  forkSessionKey: string;
  source: "tip" | "reply";
  placement: "child" | "current";
  sourceConversation: ConversationRef;
  previous: ReturnType<typeof snapshotBinding>;
};

type PreparedFork = {
  ticket: string;
  title?: string;
  source: "tip" | "reply";
  operationId: string;
  forkSessionKey?: string;
  replyEntryId?: string;
  replayText?: string;
  previous: ReturnType<typeof snapshotBinding>;
};

async function readReplySelection(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  replyToId: string;
}): Promise<
  { status: "found"; entryId: string; text: string } | { status: "media" } | { status: "missing" }
> {
  const { loadAccessorSessionEntryForGatewayTarget } =
    await import("../gateway/server-methods/sessions-shared.js");
  const current = loadAccessorSessionEntryForGatewayTarget({
    key: params.sessionKey,
    cfg: params.config,
    agentId: params.agentId,
  });
  if (!current.entry?.sessionId || current.entry.repositoryWorkspaceId) {
    return { status: "missing" };
  }
  const { readRecentSessionTranscriptActiveEvents } =
    await import("../config/sessions/session-accessor.js");
  const events = readRecentSessionTranscriptActiveEvents(
    {
      agentId: current.target.agentId,
      sessionId: current.entry.sessionId,
      sessionKey: current.canonicalKey,
      storePath: current.storePath,
    },
    2_000,
  );
  for (let index = events.length - 1; index >= 0; index--) {
    // SAFETY: transcript events are treated as partial untrusted records and every consumed field is checked below.
    const event = events[index] as {
      id?: unknown;
      message?: {
        role?: unknown;
        content?: unknown;
        transport?: { messageId?: unknown };
        media?: unknown[];
      };
    };
    const message = event.message;
    if (
      typeof event.id !== "string" ||
      message?.role !== "user" ||
      message.transport?.messageId !== params.replyToId
    ) {
      continue;
    }
    if (Array.isArray(message.media) && message.media.length > 0) {
      return { status: "media" };
    }
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part) =>
                part && typeof part === "object" && "text" in part && typeof part.text === "string"
                  ? part.text
                  : "",
              )
              .join("")
          : "";
    return text.trim() ? { status: "found", entryId: event.id, text } : { status: "missing" };
  }
  return { status: "missing" };
}

function snapshotBinding(binding: SessionBindingRecord | null) {
  if (!binding) {
    return null;
  }
  return {
    bindingId: binding.bindingId,
    generation: binding.generation,
    targetSessionKey: binding.targetSessionKey,
    targetKind: binding.targetKind,
    conversation: binding.conversation,
    boundAt: binding.boundAt,
    expiresAt: binding.expiresAt,
    metadata: binding.metadata,
  };
}

function isForkMetadata(value: unknown): value is ForkMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "operationId" in value &&
    typeof value.operationId === "string" &&
    "sourceSessionKey" in value &&
    typeof value.sourceSessionKey === "string" &&
    "forkSessionKey" in value &&
    typeof value.forkSessionKey === "string" &&
    "placement" in value &&
    (value.placement === "child" || value.placement === "current") &&
    "sourceConversation" in value &&
    typeof value.sourceConversation === "object" &&
    value.sourceConversation !== null &&
    "source" in value &&
    (value.source === "tip" || value.source === "reply") &&
    "previous" in value
  );
}

function readForkMetadata(binding: SessionBindingRecord | null): ForkMetadata | null {
  const value = binding?.metadata?.[METADATA_KEY];
  return isForkMetadata(value) ? value : null;
}

function telegramConversationUrl(conversation: ConversationRef): string | undefined {
  if (conversation.channel !== "telegram") {
    return undefined;
  }
  const match = /^(-100\d+):topic:(\d+)$/u.exec(conversation.conversationId);
  if (!match) {
    return undefined;
  }
  return `https://t.me/c/${match[1]!.slice(4)}/${match[2]}`;
}

function bindingStillMatches(current: SessionBindingRecord | null, expected: SessionBindingRecord) {
  return (
    matchesActiveSessionBindingSnapshot(expected, current, Date.now()) &&
    readForkMetadata(current)?.operationId === readForkMetadata(expected)?.operationId
  );
}

function remainingTtlMs(binding: NonNullable<PreparedFork["previous"]>): number | undefined {
  return binding.expiresAt === undefined ? undefined : Math.max(1, binding.expiresAt - Date.now());
}

export function createPluginCommandConversationForkHost(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  conversation: ConversationRef;
  replyToId?: string;
  signal: AbortSignal;
  assertOwnerCurrent?: () => void;
}): PluginCommandConversationForkHost {
  const service = getSessionBindingService();
  let prepared: PreparedFork | undefined;

  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertOwnerCurrent?.();
  };

  const ensureForkSession = async (plan: PreparedFork) => {
    if (plan.forkSessionKey) {
      return plan.forkSessionKey;
    }
    assertCurrent();
    if (plan.source === "reply") {
      if (!plan.replyEntryId) {
        return undefined;
      }
      const { forkSessionAtMessage } = await import("../config/sessions/session-accessor.js");
      const { loadAccessorSessionEntryForGatewayTarget } =
        await import("../gateway/server-methods/sessions-shared.js");
      const { buildDashboardSessionKey } = await import("../gateway/session-create-service.js");
      const { isCompetingSessionWorkAdmissionActive, runExclusiveSessionLifecycleMutation } =
        await import("../sessions/session-lifecycle-admission.js");
      const { recordSessionCreated } = await import("../sessions/session-created.js");
      const initial = loadAccessorSessionEntryForGatewayTarget({
        key: params.sessionKey,
        cfg: params.config,
        agentId: params.agentId,
      });
      if (!initial.entry?.sessionId || initial.entry.repositoryWorkspaceId) {
        return undefined;
      }
      const initialEntry = initial.entry;
      const identities = [
        params.sessionKey,
        initial.canonicalKey,
        initial.sessionStoreKey,
        initialEntry.sessionId,
        initialEntry.lifecycleRevision,
      ];
      const targetKey = buildDashboardSessionKey(initial.target.agentId, {
        incognito: initialEntry.incognito === true,
      });
      let createdKey: string | undefined;
      await runExclusiveSessionLifecycleMutation({
        scope: initial.storePath,
        identities,
        run: async () => {
          assertCurrent();
          const current = loadAccessorSessionEntryForGatewayTarget({
            key: params.sessionKey,
            cfg: params.config,
            agentId: params.agentId,
          });
          const currentEntry = current.entry;
          if (
            currentEntry?.sessionId !== initialEntry.sessionId ||
            currentEntry.lifecycleRevision !== initialEntry.lifecycleRevision ||
            isCompetingSessionWorkAdmissionActive(initial.storePath, identities)
          ) {
            return;
          }
          const result = await forkSessionAtMessage(
            {
              agentId: current.target.agentId,
              commitGuard: assertCurrent,
              sessionKey: current.canonicalKey,
              sessionStoreKey: current.sessionStoreKey,
              storePath: current.storePath,
              entryId: plan.replyEntryId!,
              targetKey,
              creation: { via: "plugin" },
            },
            {
              sessionId: currentEntry.sessionId,
              lifecycleRevision: currentEntry.lifecycleRevision,
            },
          );
          if (result.status === "created") {
            recordSessionCreated(params.config, {
              sessionKey: result.key,
              agentId: current.target.agentId,
              entry: result.entry,
            });
            createdKey = result.key;
          }
        },
      });
      plan.forkSessionKey = createdKey;
      return createdKey;
    }
    const { createGatewaySession } = await import("../gateway/session-create-service.js");
    const created = await createGatewaySession({
      cfg: params.config,
      agentId: params.agentId,
      parentSessionKey: params.sessionKey,
      fork: true,
      succeedsParent: false,
      commandSource: "plugin-command:conversation-fork",
      commitGuard: assertCurrent,
      ...(plan.title ? { displayName: plan.title } : {}),
    });
    if (!created.ok) {
      return undefined;
    }
    plan.forkSessionKey = created.key;
    return created.key;
  };

  return {
    version: 1,
    async prepare(input = {}) {
      assertCurrent();
      const replySelection = params.replyToId
        ? await readReplySelection({
            config: params.config,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            replyToId: params.replyToId,
          })
        : undefined;
      if (replySelection?.status === "media") {
        return { status: "blocked", reason: "media_unavailable" };
      }
      if (params.replyToId && replySelection?.status !== "found") {
        return { status: "blocked", reason: "reply_unavailable" };
      }
      const reply = replySelection?.status === "found" ? replySelection : undefined;
      const capabilities = service.getCapabilities(params.conversation);
      const child = capabilities.bindSupported && capabilities.placements.includes("child");
      const current = capabilities.bindSupported && capabilities.placements.includes("current");
      if (!child && !current) {
        return { status: "blocked", reason: "unsupported" };
      }
      prepared = {
        ticket: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        title: input.title,
        source: reply ? "reply" : "tip",
        ...(reply ? { replyEntryId: reply.entryId, replayText: reply.text } : {}),
        previous: snapshotBinding(await service.resolveByConversationAsync(params.conversation)),
      };
      return {
        status: "ready",
        ticket: prepared.ticket,
        child,
        current,
        shared: true,
        source: prepared.source,
      };
    },
    async execute(input) {
      assertCurrent();
      const plan = prepared;
      if (!plan || input.ticket !== plan.ticket) {
        return { status: "blocked", reason: "unauthorized" };
      }
      const forkSessionKey = await ensureForkSession(plan);
      if (!forkSessionKey) {
        return { status: "not_placed", effect: "none", reason: "creation_failed" };
      }
      const metadata: ForkMetadata = {
        version: 1,
        operationId: plan.operationId,
        sourceSessionKey: params.sessionKey,
        forkSessionKey,
        source: plan.source,
        placement: input.placement,
        sourceConversation: params.conversation,
        previous: plan.previous,
      };
      try {
        const binding = await service.bind({
          targetSessionKey: forkSessionKey,
          targetKind: "session",
          conversation: params.conversation,
          placement: input.placement,
          assertCurrent,
          metadata: {
            [METADATA_KEY]: metadata,
            ...(plan.title ? { label: plan.title, threadName: plan.title } : {}),
          },
        });
        if (plan.source === "reply") {
          if (!plan.replayText) {
            return { status: "blocked", reason: "reply_unavailable" };
          }
          const { dispatchInboundMessageWithRoutedChannelDispatcher } =
            await import("../auto-reply/dispatch.js");
          const { routeReply } = await import("../auto-reply/reply/route-reply.js");
          await dispatchInboundMessageWithRoutedChannelDispatcher({
            cfg: params.config,
            ctx: {
              Body: plan.replayText,
              From: binding.conversation.conversationId,
              To: binding.conversation.conversationId,
              Provider: binding.conversation.channel,
              Surface: binding.conversation.channel,
              OriginatingChannel: binding.conversation.channel,
              OriginatingTo: binding.conversation.conversationId,
              AccountId: binding.conversation.accountId,
              SessionKey: forkSessionKey,
              AgentId: params.agentId,
              MessageSid: `conversation-fork-replay:${plan.operationId}`,
              InputProvenance: {
                kind: "external_user",
                sourceChannel: binding.conversation.channel,
                sourceTool: "conversation_fork_reply_replay",
              },
              InboundAccessAuthorized: true,
            },
            dispatcherOptions: {
              deliver: async (payload, info) => {
                const sent = await routeReply({
                  cfg: params.config,
                  payload,
                  channel: binding.conversation.channel,
                  to: binding.conversation.conversationId,
                  accountId: binding.conversation.accountId,
                  agentId: params.agentId,
                  sessionKey: forkSessionKey,
                  replyKind: info.kind,
                  mirror: false,
                });
                if (!sent.ok && (!sent.delivered || sent.ambiguous)) {
                  throw new Error(sent.error, { cause: sent.cause });
                }
                return {
                  visibleReplySent: sent.delivered,
                  ...(sent.ambiguous ? { ambiguous: true } : {}),
                  ...(sent.suppressed ? { suppression: { reason: sent.reason } } : {}),
                };
              },
            },
          });
        }
        prepared = undefined;
        return {
          status: "placed",
          placement: input.placement,
          returnReady: true,
          source: plan.source,
          shared: true,
          replay: plan.source === "reply" ? "submitted" : "none",
          conversationId: binding.conversation.conversationId,
          ...(telegramConversationUrl(binding.conversation)
            ? { destinationUrl: telegramConversationUrl(binding.conversation) }
            : {}),
        };
      } catch (error) {
        if (isSessionBindingError(error)) {
          return {
            status: "not_placed",
            effect: "session_only",
            reason:
              error.code === "BINDING_CAPABILITY_UNSUPPORTED"
                ? "unsupported"
                : error.code === "BINDING_ADAPTER_UNAVAILABLE"
                  ? "unsupported"
                  : "creation_failed",
          };
        }
        return { status: "pending" };
      }
    },
    async back() {
      assertCurrent();
      const current = await service.resolveByConversationAsync(params.conversation);
      const metadata = readForkMetadata(current);
      if (!current || !metadata) {
        return { status: "no_previous" };
      }
      if (metadata.placement === "child") {
        const destinationUrl = telegramConversationUrl(metadata.sourceConversation);
        return destinationUrl
          ? { status: "returned", mode: "navigate", destinationUrl }
          : { status: "no_previous" };
      }
      const compare = () => {
        assertCurrent();
        if (!bindingStillMatches(service.resolveByConversation(params.conversation), current)) {
          throw new Error("conversation fork binding changed");
        }
      };
      try {
        compare();
        const previous = metadata.previous;
        await service.bind({
          targetSessionKey: previous?.targetSessionKey ?? metadata.sourceSessionKey,
          targetKind: previous?.targetKind ?? "session",
          conversation: previous?.conversation ?? params.conversation,
          placement: "current",
          metadata: previous?.metadata,
          ...(previous && remainingTtlMs(previous) !== undefined
            ? { ttlMs: remainingTtlMs(previous) }
            : {}),
          assertCurrent: compare,
        });
        return { status: "returned", mode: "restored", shared: true };
      } catch {
        return { status: "conflict" };
      }
    },
    async status() {
      assertCurrent();
      const current = await service.resolveByConversationAsync(params.conversation);
      const metadata = readForkMetadata(current);
      return metadata
        ? {
            status: "placed",
            placement: metadata.placement,
            returnReady: true,
            source: metadata.source,
            shared: true,
            replay: metadata.source === "reply" ? "submitted" : "none",
          }
        : { status: "idle" };
    },
  };
}
