import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  matchesActiveSessionBindingRoute,
  matchesActiveSessionBindingSnapshot,
} from "../infra/outbound/session-binding-identity.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type ConversationRef,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  sameConversationRef,
  telegramConversationUrl,
} from "./plugin-command-conversation-fork-conversation.js";
import {
  hasPendingChildPlacement,
  reserveChildPlacement,
  settleChildPlacement,
} from "./plugin-command-conversation-fork-pending.js";
import { readPluginForkReplySelection } from "./plugin-command-conversation-fork-reply-selection.js";
import { loadPluginForkSourceTarget } from "./plugin-command-fork-source-target.js";
import type { PluginCommandConversationForkHost } from "./plugin-command.types.js";

const METADATA_KEY = "conversationFork";

class SourceBindingChangedError extends Error {}

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

function isAuthorizedForkBinding(params: {
  binding: SessionBindingRecord;
  metadata: ForkMetadata;
  agentId: string;
  conversation: ConversationRef;
}): boolean {
  const { binding, metadata, agentId, conversation } = params;
  const source = metadata.sourceConversation;
  const previous = metadata.previous;
  return (
    binding.targetKind === "session" &&
    binding.targetSessionKey === metadata.forkSessionKey &&
    sameConversationRef(binding.conversation, conversation) &&
    parseAgentSessionKey(metadata.sourceSessionKey)?.agentId === agentId &&
    parseAgentSessionKey(metadata.forkSessionKey)?.agentId === agentId &&
    typeof source.channel === "string" &&
    typeof source.accountId === "string" &&
    typeof source.conversationId === "string" &&
    (source.parentConversationId === undefined ||
      typeof source.parentConversationId === "string") &&
    source.channel === conversation.channel &&
    source.accountId === conversation.accountId &&
    (metadata.placement !== "current" || sameConversationRef(source, conversation)) &&
    (previous === null ||
      (typeof previous === "object" &&
        sameConversationRef(previous.conversation, source) &&
        previous.targetSessionKey === metadata.sourceSessionKey &&
        parseAgentSessionKey(previous.targetSessionKey)?.agentId === agentId))
  );
}

function bindingStillMatches(current: SessionBindingRecord | null, expected: SessionBindingRecord) {
  return (
    matchesActiveSessionBindingSnapshot(expected, current, Date.now()) &&
    readForkMetadata(current)?.operationId === readForkMetadata(expected)?.operationId
  );
}

function replayBindingStillMatches(
  current: SessionBindingRecord | null,
  expected: SessionBindingRecord,
): boolean {
  const metadata = readForkMetadata(expected);
  return (
    metadata !== null &&
    matchesActiveSessionBindingRoute(expected, current, Date.now()) &&
    isDeepStrictEqual(metadata, readForkMetadata(current))
  );
}

function remainingTtlMs(binding: NonNullable<PreparedFork["previous"]>): number | undefined {
  if (binding.expiresAt === undefined) {
    return undefined;
  }
  const remaining = binding.expiresAt - Date.now();
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

export function createPluginCommandConversationForkHost(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  conversation: ConversationRef;
  replyToId?: string;
  replyConversationRef?: string;
  signal: AbortSignal;
  assertOwnerCurrent?: () => void;
}): PluginCommandConversationForkHost {
  const service = getSessionBindingService();
  let prepared: PreparedFork | undefined;
  let executing = false;
  let placementUncertain = false;

  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertOwnerCurrent?.();
  };

  const assertSourceBinding = (plan: PreparedFork) => {
    assertCurrent();
    if (plan.previous && !plan.previous.generation) {
      throw new SourceBindingChangedError("source binding has no durable generation");
    }
    const observed = snapshotBinding(service.resolveByConversation(params.conversation));
    if (!isDeepStrictEqual(observed, plan.previous)) {
      throw new SourceBindingChangedError(
        "source conversation binding changed during fork placement",
      );
    }
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
      const { isCompetingSessionWorkAdmissionActive, runExclusiveSessionLifecycleMutation } =
        await import("../sessions/session-lifecycle-admission.js");
      const { recordSessionCreated } = await import("../sessions/session-created.js");
      const initial = await loadPluginForkSourceTarget({
        config: params.config,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        assertCurrent,
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
      const targetKey = `agent:${initial.target.agentId}:dashboard:${
        initialEntry.incognito === true ? "incognito-" : ""
      }${crypto.randomUUID()}`;
      let createdKey: string | undefined;
      await runExclusiveSessionLifecycleMutation({
        scope: initial.storePath,
        identities,
        run: async () => {
          assertCurrent();
          const current = await loadPluginForkSourceTarget({
            config: params.config,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            assertCurrent,
          });
          const currentEntry = current.entry;
          if (
            currentEntry?.sessionId !== initialEntry.sessionId ||
            currentEntry.lifecycleRevision !== initialEntry.lifecycleRevision ||
            isCompetingSessionWorkAdmissionActive(initial.storePath, identities)
          ) {
            return;
          }
          const { forkReplySession } =
            await import("./plugin-command-conversation-fork-reply-cut.js");
          const result = await forkReplySession(
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
            currentEntry.incognito === true,
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
      // An owner plugin command runs in the parent's admitted turn. Branch its
      // completed prefix without invoking /new-style parent reset hooks.
      forkFrom: "last-completed",
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
      if (params.conversation.channel !== "telegram" && params.conversation.channel !== "discord") {
        return { status: "blocked", reason: "unsupported" };
      }
      if (placementUncertain || (await hasPendingChildPlacement(params.conversation))) {
        return { status: "pending" };
      }
      if (executing) {
        return { status: "pending" };
      }
      const replySelection = params.replyToId
        ? await readPluginForkReplySelection({
            config: params.config,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            replyToId: params.replyToId,
            conversation: params.conversation,
            replyConversationRef: params.replyConversationRef,
            assertCurrent,
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
      // Back from a child needs a verified source destination. Topic URLs are
      // derivable here; Discord and flat Telegram source IDs are not.
      const child =
        capabilities.bindSupported &&
        capabilities.placements.includes("child") &&
        Boolean(telegramConversationUrl(params.conversation));
      const current = capabilities.bindSupported && capabilities.placements.includes("current");
      if (!child && !current) {
        return { status: "blocked", reason: "unsupported" };
      }
      let previous = snapshotBinding(await service.resolveByConversationAsync(params.conversation));
      assertCurrent();
      if (
        previous &&
        (previous.targetKind !== "session" || previous.targetSessionKey !== params.sessionKey)
      ) {
        return { status: "blocked", reason: "binding_changed" };
      }
      if (previous && !previous.generation) {
        if (!current) {
          return { status: "blocked", reason: "source_binding_unfenced" };
        }
        const legacy = previous;
        if (remainingTtlMs(legacy) === 0) {
          return { status: "blocked", reason: "binding_changed" };
        }
        try {
          previous = snapshotBinding(
            await service.bind({
              targetSessionKey: legacy.targetSessionKey,
              targetKind: legacy.targetKind,
              conversation: legacy.conversation,
              placement: "current",
              metadata: legacy.metadata,
              ...(legacy.expiresAt !== undefined ? { expiresAt: legacy.expiresAt } : {}),
              assertCurrent: () => {
                assertCurrent();
                if (remainingTtlMs(legacy) === 0) {
                  throw new SourceBindingChangedError("legacy binding expired during upgrade");
                }
                if (
                  !isDeepStrictEqual(
                    snapshotBinding(service.resolveByConversation(params.conversation)),
                    legacy,
                  )
                ) {
                  throw new SourceBindingChangedError("legacy binding changed during upgrade");
                }
              },
            }),
          );
        } catch {
          return { status: "blocked", reason: "binding_changed" };
        }
        if (!previous?.generation) {
          return { status: "blocked", reason: "source_binding_unfenced" };
        }
      }
      prepared = {
        ticket: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        title: input.title,
        source: reply ? "reply" : "tip",
        ...(reply ? { replyEntryId: reply.entryId, replayText: reply.text } : {}),
        previous,
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
      if (placementUncertain || (await hasPendingChildPlacement(params.conversation))) {
        return { status: "pending" };
      }
      const plan = prepared;
      if (!plan || input.ticket !== plan.ticket || executing) {
        return { status: "blocked", reason: "unauthorized" };
      }
      if (input.placement === "child" && !telegramConversationUrl(params.conversation)) {
        return { status: "not_placed", effect: "none", reason: "unsupported" };
      }
      executing = true;
      try {
        try {
          assertSourceBinding(plan);
        } catch (error) {
          if (error instanceof SourceBindingChangedError) {
            return { status: "blocked", reason: "binding_changed" };
          }
          throw error;
        }
        let forkSessionKey: string | undefined;
        try {
          forkSessionKey = await ensureForkSession(plan);
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            // A committed cut may have created the child session; never replay this ticket.
            prepared = undefined;
          }
          throw error;
        }
        if (!forkSessionKey) {
          return { status: "not_placed", effect: "none", reason: "creation_failed" };
        }
        // Recheck after session creation as well as at the synchronous adapter commit.
        if (
          !isDeepStrictEqual(
            snapshotBinding(await service.resolveByConversationAsync(params.conversation)),
            plan.previous,
          )
        ) {
          return { status: "blocked", reason: "binding_changed" };
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
        let childReserved = false;
        try {
          if (input.placement === "child") {
            childReserved = await reserveChildPlacement(params.conversation, plan.operationId);
            if (!childReserved) {
              placementUncertain = true;
              prepared = undefined;
              return { status: "pending" };
            }
            assertSourceBinding(plan);
          }
          const binding = await service.bind({
            targetSessionKey: forkSessionKey,
            targetKind: "session",
            conversation: params.conversation,
            placement: input.placement,
            assertCurrent: () => assertSourceBinding(plan),
            requireLiveSourceAtCommit: true,
            metadata: {
              [METADATA_KEY]: metadata,
              ...(plan.title ? { label: plan.title, threadName: plan.title } : {}),
            },
          });
          if (
            childReserved &&
            !(await settleChildPlacement(params.conversation, plan.operationId))
          ) {
            throw new Error("Child placement settled without its durable uncertainty marker");
          }
          // Placement is a committed effect. Never retry this ticket if dispatch
          // throws after accepting the replay: its outcome may be unknowable.
          prepared = undefined;
          let replay: "none" | "submitted" | "ambiguous" = "none";
          if (plan.source === "reply") {
            if (!plan.replayText) {
              return { status: "placed", replay: "ambiguous", reason: "reply_unavailable" };
            }
            replay = "submitted";
            try {
              const assertReplayRouteCurrent = () => {
                // Replay may drain after the command invocation closes. Keep the
                // host-issued owner check, not the command's short-lived signal.
                params.assertOwnerCurrent?.();
                if (
                  !replayBindingStillMatches(
                    service.resolveByConversation(binding.conversation),
                    binding,
                  )
                ) {
                  throw new Error("conversation fork replay route changed");
                }
              };
              assertReplayRouteCurrent();
              const { dispatchInboundMessageWithRoutedChannelDispatcher } =
                await import("../auto-reply/dispatch.js");
              const { getReplyFromConfig } =
                await import("../auto-reply/reply/get-reply-from-config.runtime.js");
              const { routeReply } = await import("../auto-reply/reply/route-reply.js");
              assertReplayRouteCurrent();
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
                // Recheck after dispatch preparation and any queue wait, at the
                // boundary immediately before model/tool execution begins.
                replyResolver: (ctx, options, configOverride) => {
                  assertReplayRouteCurrent();
                  const replayOptions = {
                    ...options,
                    assertForkReplaySourceCurrent: assertReplayRouteCurrent,
                  };
                  return getReplyFromConfig(ctx, replayOptions, configOverride);
                },
                dispatcherOptions: {
                  deliver: async (payload, info) => {
                    assertReplayRouteCurrent();
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
                      assertDirectAdapterHandoff: assertReplayRouteCurrent,
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
            } catch {
              replay = "ambiguous";
            }
          }
          return {
            status: "placed",
            placement: input.placement,
            returnReady: true,
            source: plan.source,
            shared: true,
            replay,
            conversationId: binding.conversation.conversationId,
            ...(telegramConversationUrl(binding.conversation)
              ? { destinationUrl: telegramConversationUrl(binding.conversation) }
              : {}),
          };
        } catch (error) {
          if (error instanceof SourceBindingChangedError) {
            return { status: "blocked", reason: "binding_changed" };
          }
          if (isSessionBindingError(error)) {
            if (childReserved) {
              try {
                const settled = await settleChildPlacement(params.conversation, plan.operationId);
                if (!settled) {
                  prepared = undefined;
                  placementUncertain = true;
                  return { status: "pending" };
                }
              } catch {
                prepared = undefined;
                placementUncertain = true;
                return { status: "pending" };
              }
            }
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
          // The native child operation may have committed even if its reply or
          // adapter publication was lost. Consume this ticket and forbid an
          // in-process retry or fallback until an operator reconciles it.
          prepared = undefined;
          placementUncertain = true;
          return { status: "pending" };
        }
      } finally {
        executing = false;
      }
    },
    async back() {
      assertCurrent();
      if (placementUncertain || (await hasPendingChildPlacement(params.conversation))) {
        return { status: "pending" };
      }
      const current = await service.resolveByConversationAsync(params.conversation);
      const metadata = readForkMetadata(current);
      if (
        !current ||
        !metadata ||
        !isAuthorizedForkBinding({
          binding: current,
          metadata,
          agentId: params.agentId,
          conversation: params.conversation,
        })
      ) {
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
        if (!previous) {
          const removed = await service.unbind({
            bindingId: current.bindingId,
            scope: {
              channel: params.conversation.channel,
              accountId: params.conversation.accountId,
            },
            reason: "conversation-fork-back",
            assertCurrent: compare,
          });
          if (removed.length !== 1 || !bindingStillMatches(removed[0] ?? null, current)) {
            return { status: "conflict" };
          }
          return { status: "returned", mode: "restored", shared: true };
        }
        if (remainingTtlMs(previous) === 0) {
          return { status: "conflict" };
        }
        await service.bind({
          targetSessionKey: previous.targetSessionKey,
          targetKind: previous.targetKind,
          conversation: previous.conversation,
          placement: "current",
          metadata: previous.metadata,
          ...(previous.expiresAt !== undefined ? { expiresAt: previous.expiresAt } : {}),
          assertCurrent: () => {
            compare();
            if (remainingTtlMs(previous) === 0) {
              throw new Error("previous fork binding expired before return");
            }
          },
        });
        return { status: "returned", mode: "restored", shared: true };
      } catch {
        return { status: "conflict" };
      }
    },
    async status() {
      assertCurrent();
      if (placementUncertain || (await hasPendingChildPlacement(params.conversation))) {
        return { status: "pending" };
      }
      const current = await service.resolveByConversationAsync(params.conversation);
      const metadata = readForkMetadata(current);
      return current &&
        metadata &&
        isAuthorizedForkBinding({
          binding: current,
          metadata,
          agentId: params.agentId,
          conversation: params.conversation,
        })
        ? {
            status: "placed",
            placement: metadata.placement,
            returnReady: true,
            source: metadata.source,
            shared: true,
            // The binding persists placement, not an exactly-once replay receipt.
            replay: metadata.source === "reply" ? "unknown" : "none",
          }
        : { status: "idle" };
    },
  };
}
