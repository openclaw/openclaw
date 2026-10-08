import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { matchesActiveSessionBindingRoute } from "../../infra/outbound/session-binding-identity.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type ConversationRef,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { readNativeForkReplySelection } from "./commands-fork-reply-selection.js";
import { loadNativeForkSourceTarget } from "./commands-fork-source-target.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
type NativeConversationForkHost = {
  version: 1;
  prepare: (params?: { title?: string }) => Promise<
    | {
        status: "ready";
        ticket: string;
        child: boolean;
        current: boolean;
        shared: boolean;
        source: "tip" | "reply";
      }
    | { status: "blocked"; reason: string }
    | { status: "pending" }
  >;
  execute: (params: {
    ticket: string;
    placement: "child" | "current";
  }) => Promise<Readonly<Record<string, unknown>> & { status: string }>;
  back: () => Promise<Readonly<Record<string, unknown>> & { status: string }>;
  status: () => Promise<Readonly<Record<string, unknown>> & { status: string }>;
};

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

function sameConversationRef(a: ConversationRef, b: ConversationRef): boolean {
  // Telegram flat groups may omit a redundant self-parent that ingress includes.
  // The Telegram binding store omits a topic's inferable parent on reload;
  // ingress still supplies it. Keep an explicitly wrong parent mismatched.
  const flatTelegramGroup = a.channel === "telegram" && /^-[0-9]+$/u.test(a.conversationId);
  const topicParent =
    a.channel === "telegram" ? /^(-100\d+):topic:\d+$/u.exec(a.conversationId)?.[1] : undefined;
  const aParent =
    flatTelegramGroup && a.parentConversationId === a.conversationId
      ? undefined
      : (a.parentConversationId ?? topicParent);
  const bParent =
    flatTelegramGroup && b.parentConversationId === b.conversationId
      ? undefined
      : (b.parentConversationId ?? topicParent);
  return (
    a.channel === b.channel &&
    a.accountId === b.accountId &&
    a.conversationId === b.conversationId &&
    aParent === bParent
  );
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
    matchesActiveSessionBindingRoute(expected, current, Date.now()) &&
    readForkMetadata(current)?.operationId === readForkMetadata(expected)?.operationId
  );
}

function remainingTtlMs(binding: NonNullable<PreparedFork["previous"]>): number | undefined {
  if (binding.expiresAt === undefined) {
    return undefined;
  }
  const remaining = binding.expiresAt - Date.now();
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

export function createNativeConversationForkHost(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  conversation: ConversationRef;
  replyToId?: string;
  replyConversationRef?: string;
  signal: AbortSignal;
  assertOwnerCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): NativeConversationForkHost {
  const service = getSessionBindingService();
  let prepared: PreparedFork | undefined;
  let executing = false;

  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertOwnerCurrent?.();
  };

  const assertSourceBinding = (plan: PreparedFork) => {
    assertCurrent();
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
      const { buildDashboardSessionKey } = await import("../../gateway/session-create-key.js");
      const { isCompetingSessionWorkAdmissionActive, runExclusiveSessionLifecycleMutation } =
        await import("../../sessions/session-lifecycle-admission.js");
      const { recordSessionCreated } = await import("../../sessions/session-created.js");
      const initial = await loadNativeForkSourceTarget({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
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
      const targetKey = buildDashboardSessionKey(initial.target.agentId, {
        incognito: initialEntry.incognito === true,
      });
      let createdKey: string | undefined;
      await runExclusiveSessionLifecycleMutation("fork", {
        scope: initial.storePath,
        identities,
        run: async () => {
          assertCurrent();
          const current = await loadNativeForkSourceTarget({
            config: params.config,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            assertCurrent,
          });
          assertCurrent();
          const currentEntry = current.entry;
          if (
            currentEntry?.sessionId !== initialEntry.sessionId ||
            currentEntry.lifecycleRevision !== initialEntry.lifecycleRevision ||
            isCompetingSessionWorkAdmissionActive(initial.storePath, identities)
          ) {
            return;
          }
          // The session history owner selects the canonical worker transaction
          // for durable sessions and retains the native incognito path.
          const { forkSessionAtMessage } =
            await import("../../config/sessions/session-accessor.js");
          const result = await forkSessionAtMessage(
            {
              agentId: current.target.agentId,
              commitGuard: assertCurrent,
              sessionKey: current.canonicalKey,
              sessionStoreKey: current.sessionStoreKey,
              storePath: current.storePath,
              entryId: plan.replyEntryId!,
              targetKey,
              creation: { via: "channel" },
            },
            {
              sessionId: currentEntry.sessionId,
              lifecycleRevision: currentEntry.lifecycleRevision,
            },
          );
          if (result.status === "created") {
            await recordSessionCreated(params.config, {
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
    const { createGatewaySession } = await import("../../gateway/session-create-service.js");
    const created = await createGatewaySession({
      cfg: params.config,
      agentId: params.agentId,
      parentSessionKey: params.sessionKey,
      fork: true,
      // This side branch runs inside the parent's admitted command turn. Fork
      // the completed transcript prefix without /new-style parent reset hooks.
      forkFrom: "last-completed",
      commandSource: "native-command:fork",
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
      if (executing) {
        return { status: "pending" };
      }
      // Matrix cannot fence placement; Feishu does not publish the generation
      // required to replay or restore a newly placed current binding.
      if (params.conversation.channel === "matrix" || params.conversation.channel === "feishu") {
        return { status: "blocked", reason: "unsupported" };
      }
      const replySelection = params.replyToId
        ? await readNativeForkReplySelection({
            config: params.config,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            replyToId: params.replyToId,
            conversation: params.conversation,
            replyConversationRef: params.replyConversationRef,
            assertCurrent,
          })
        : undefined;
      assertCurrent();
      if (replySelection?.status === "media") {
        return { status: "blocked", reason: "media_unavailable" };
      }
      if (params.replyToId && replySelection?.status !== "found") {
        return { status: "blocked", reason: "reply_unavailable" };
      }
      const reply = replySelection?.status === "found" ? replySelection : undefined;
      if (reply && !params.assertOwnerCurrent) {
        return { status: "blocked", reason: "owner_authority_unavailable" };
      }
      const capabilities = service.getCapabilities(params.conversation);
      const child = capabilities.bindSupported && capabilities.placements.includes("child");
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
              ...(remainingTtlMs(legacy) !== undefined ? { ttlMs: remainingTtlMs(legacy) } : {}),
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
      const plan = prepared;
      if (!plan || input.ticket !== plan.ticket || executing) {
        return { status: "blocked", reason: "unauthorized" };
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
          // The cut may have committed even when the worker lost its result.
          // Never reuse this ticket to create another session in that case.
          if (hasSqliteWorkerOutcomeUnknown(error)) {
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
          return {
            status: "not_placed",
            effect: "session_only",
            reason: "binding_changed",
            forkSessionKey,
          };
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
            assertCurrent: () => assertSourceBinding(plan),
            metadata: {
              [METADATA_KEY]: metadata,
              ...(plan.title ? { label: plan.title, threadName: plan.title } : {}),
            },
          });
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
                // Replay can outlive the command's abort signal after placement;
                // its authority is the original live owner plus committed route.
                if (!params.assertOwnerCurrent) {
                  throw new Error("conversation fork replay owner authority missing");
                }
                params.assertOwnerCurrent();
                if (
                  !bindingStillMatches(service.resolveByConversation(binding.conversation), binding)
                ) {
                  throw new Error("conversation fork replay route changed");
                }
              };
              assertReplayRouteCurrent();
              const { dispatchInboundMessageWithRoutedChannelDispatcher } =
                await import("../../auto-reply/dispatch.js");
              const { routeReply } = await import("../../auto-reply/reply/route-reply.js");
              const { getReplyFromConfig } = await import("./get-reply.js");
              const sourceAuthority = params.operatorAuthority;
              if (sourceAuthority) {
                assertAdmittedRunOperatorAuthority(sourceAuthority);
              }
              const replayAuthority = sourceAuthority
                ? createAdmittedRunOperatorAuthority({
                    ...sourceAuthority,
                    assertCurrent: () => {
                      sourceAuthority.assertCurrent();
                      assertReplayRouteCurrent();
                    },
                  })
                : undefined;
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
                replyResolver: (ctx, options, configOverride) => {
                  // A queued replay may reach model admission after the initiating route changes.
                  assertReplayRouteCurrent();
                  const guardedOptions: InternalGetReplyOptions = {
                    ...options,
                    assertForkReplaySourceCurrent: assertReplayRouteCurrent,
                    ...(replayAuthority ? { operatorAuthority: replayAuthority } : {}),
                  };
                  return getReplyFromConfig(ctx, guardedOptions, configOverride);
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
            return {
              status: "not_placed",
              effect: "session_only",
              reason: "binding_changed",
              forkSessionKey,
            };
          }
          if (isSessionBindingError(error)) {
            return {
              status: "not_placed",
              effect: "session_only",
              forkSessionKey,
              reason:
                error.code === "BINDING_CAPABILITY_UNSUPPORTED"
                  ? "unsupported"
                  : error.code === "BINDING_ADAPTER_UNAVAILABLE"
                    ? "unsupported"
                    : "creation_failed",
            };
          }
          return { status: "ambiguous", forkSessionKey };
        }
      } finally {
        executing = false;
      }
    },
    async back() {
      assertCurrent();
      const current = await service.resolveByConversationAsync(params.conversation);
      const metadata = readForkMetadata(current);
      const source = metadata?.sourceConversation;
      const previous = metadata?.previous;
      if (
        !current ||
        !metadata ||
        current.targetKind !== "session" ||
        current.targetSessionKey !== metadata.forkSessionKey ||
        !sameConversationRef(current.conversation, params.conversation) ||
        parseAgentSessionKey(metadata.sourceSessionKey)?.agentId !== params.agentId ||
        parseAgentSessionKey(metadata.forkSessionKey)?.agentId !== params.agentId ||
        !source ||
        typeof source.channel !== "string" ||
        typeof source.accountId !== "string" ||
        typeof source.conversationId !== "string" ||
        (source.parentConversationId !== undefined &&
          typeof source.parentConversationId !== "string") ||
        source.channel !== params.conversation.channel ||
        source.accountId !== params.conversation.accountId ||
        (metadata.placement === "current" && !sameConversationRef(source, params.conversation)) ||
        (previous !== null &&
          (!previous ||
            !sameConversationRef(previous.conversation, source) ||
            parseAgentSessionKey(previous.targetSessionKey)?.agentId !== params.agentId ||
            previous.targetSessionKey !== metadata.sourceSessionKey))
      ) {
        return { status: "no_previous" };
      }
      if (metadata.placement === "child") {
        const destinationUrl = telegramConversationUrl(metadata.sourceConversation);
        return {
          status: "returned",
          mode: "navigate",
          conversationId: metadata.sourceConversation.conversationId,
          ...(destinationUrl ? { destinationUrl } : {}),
        };
      }
      const compare = () => {
        assertCurrent();
        if (!bindingStillMatches(service.resolveByConversation(params.conversation), current)) {
          throw new Error("conversation fork binding changed");
        }
      };
      try {
        compare();
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
      const current = await service.resolveByConversationAsync(params.conversation);
      const metadata = readForkMetadata(current);
      return metadata
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
