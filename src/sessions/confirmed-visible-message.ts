// Records a confirmed outbound send in the destination conversation's model history.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { resolveCurrentConversationByDelivery } from "../config/sessions/conversation-registry.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context-store.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindOutboundSessionEntry,
  resolveOutboundSessionRoute,
  type OutboundSessionRoute,
} from "../infra/outbound/outbound-session.js";
import type { OutboundSessionContext } from "../infra/outbound/session-context.js";
import { hasReplyChannelData } from "../interactive/payload.js";
import { logWarn } from "../logger.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RoutePeer } from "../routing/resolve-route.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { deliveryContextKey } from "../utils/delivery-context.shared.js";
import {
  commitBackgroundPayloadsToSession,
  type BackgroundPayloadsCommit,
} from "./background-result-payloads.js";
import type { BackgroundSessionResultProvenance } from "./background-session-result.js";

/** Inputs describing one payload the channel confirmed as delivered. */
export type ConfirmedVisibleMessageParams = {
  config: OpenClawConfig;
  channel: ChannelId;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  /** Known destination route; `null` means the caller proved there is none. */
  route?: OutboundSessionRoute | null;
  /** The conversation whose turn produced this send, if any. */
  producer?: OutboundSessionContext;
  payload: ReplyPayload;
  /** Stable per-delivery identity; retries of the same delivery reuse it. */
  deliveryId: string;
  payloadIndex: number;
  signal?: AbortSignal;
  expectedGeneration?: { sessionKey?: string; sessionId: string; lifecycleRevision?: string };
  /** Background producer recorded on the history row, when there is one. */
  provenance?: BackgroundSessionResultProvenance;
  assertCurrent?: () => void;
  /** Fences new route-discovery I/O, not persistence of an accepted delivery. */
  assertDirectAdapterHandoff?: () => void;
  /** State root captured when the delivery began; history never follows a later ambient root. */
  stateDir?: string;
};

type ConfirmedDestination = { sessionKey: string; peer?: RoutePeer };

const skipped = (diagnostics?: string): BackgroundPayloadsCommit => ({
  ok: true,
  skipped: true,
  ...(diagnostics ? { diagnostics } : {}),
});

/** Commits only confirmed external output; a producing conversation already owns its own turn. */
export async function commitConfirmedVisibleMessage(
  params: ConfirmedVisibleMessageParams,
): Promise<BackgroundPayloadsCommit> {
  // Session stores resolve from the ambient root, so a moved root would record elsewhere.
  if (params.stateDir !== undefined && resolveStateDir(process.env) !== params.stateDir) {
    return skipped("state root changed after the delivery began");
  }
  const agentId = params.producer?.agentId ?? resolveDefaultAgentId(params.config);
  const storePath = resolveSessionStorePathCore(params.config.session?.store, { agentId });
  const toStoreKey = (requestKey: string) =>
    toAgentStoreSessionKey({ agentId, requestKey, mainKey: params.config.session?.mainKey });
  const producerKey = params.producer?.key ? toStoreKey(params.producer.key) : undefined;
  // A producer replying into its own conversation already wrote this turn.
  if (params.route && producerKey === toStoreKey(params.route.sessionKey)) {
    return skipped();
  }
  const matchesProducer = await createProducerMatcher({ params, producerKey, storePath });
  if (matchesProducer(params.route?.to ?? params.to, params.route?.threadId ?? params.threadId)) {
    return skipped();
  }

  const resolved = await resolveConfirmedDestination({ params, agentId, storePath });
  if ("skip" in resolved) {
    return skipped(resolved.skip);
  }
  const { destination, route } = resolved;
  if (!belongsToAgent(params, destination, agentId)) {
    return skipped("Conversation context skipped: the destination belongs to a different agent.");
  }
  const destinationKey = toStoreKey(destination.sessionKey);
  if (
    producerKey === destinationKey ||
    (route && matchesProducer(route.to, route.threadId ?? params.threadId))
  ) {
    return skipped();
  }
  if (!hasRecordablePayload(params.payload)) {
    return skipped(
      hasReplyChannelData(params.payload.channelData)
        ? "native-only payload not added to conversation"
        : undefined,
    );
  }

  params.assertCurrent?.();
  if (route) {
    await bindOutboundSessionEntry({
      cfg: params.config,
      channel: params.channel,
      accountId: params.accountId,
      route,
      sourceSessionKey: producerKey,
      workerGuard: { assertMutationAllowed: () => params.assertCurrent?.() },
    });
  }
  const entry = await readSessionEntryInWorker({
    agentId,
    sessionKey: destinationKey,
    storePath,
    readConsistency: "latest",
  });
  if (!entry) {
    return { ok: false, reason: "destination conversation is unavailable" };
  }
  // A caller-pinned generation applies only to the conversation it was pinned for.
  const expected = params.expectedGeneration;
  const generation =
    expected && (!expected.sessionKey || toStoreKey(expected.sessionKey) === destinationKey)
      ? expected
      : entry;
  // The destination is another conversation, so the producer's write claim must not apply.
  return await runWithoutOwnedSessionTranscriptWrites(() =>
    commitBackgroundPayloadsToSession({
      agentId,
      sessionKey: destinationKey,
      expectedGeneration: {
        sessionId: generation.sessionId,
        lifecycleRevision: generation.lifecycleRevision,
      },
      payloads: [params.payload],
      idempotencyKey: `outbound-delivery:${params.deliveryId}:${params.payloadIndex}`,
      provenance: params.provenance,
      config: params.config,
      signal: params.signal,
      assertCurrent: params.assertCurrent,
    }),
  );
}

// Returns a predicate that is true when a delivery address is the producer's own chat.
async function createProducerMatcher(input: {
  params: ConfirmedVisibleMessageParams;
  producerKey: string | undefined;
  storePath: string;
}): Promise<(to: string, threadId: string | number | null | undefined) => boolean> {
  const { params, producerKey } = input;
  if (!producerKey) {
    return () => false;
  }
  const producer = await readSessionEntryInWorker({
    sessionKey: producerKey,
    storePath: input.storePath,
    readConsistency: "latest",
  });
  const context = deliveryContextFromSession(producer);
  const producerContext = deliveryContextKey({
    ...context,
    accountId: normalizeAccountId(context?.accountId),
  });
  return (to, threadId) => {
    const destinationContext = deliveryContextKey({
      channel: params.channel,
      to,
      accountId: normalizeAccountId(params.accountId),
      threadId: threadId ?? undefined,
    });
    return Boolean(destinationContext && destinationContext === producerContext);
  };
}

// Prefers a recorded live conversation for the address, then the channel route.
// Ambiguous and unresolvable destinations are skipped with a diagnostic.
async function resolveConfirmedDestination(input: {
  params: ConfirmedVisibleMessageParams;
  agentId: string;
  storePath: string;
}): Promise<
  | { destination: ConfirmedDestination; route: OutboundSessionRoute | null | undefined }
  | { skip: string }
> {
  const { params, agentId, storePath } = input;
  if (params.route) {
    return { destination: params.route, route: params.route };
  }
  const pinned = await resolvePinnedDestination(params, agentId, storePath);
  if (pinned) {
    return { destination: pinned, route: params.route };
  }
  const selection = await resolveCurrentConversationByDelivery(
    { agentId, storePath },
    {
      channel: params.channel,
      accountId: normalizeAccountId(params.accountId),
      target: params.to.trim(),
      threadId: params.threadId == null ? undefined : String(params.threadId),
    },
  );
  if (selection.ambiguous) {
    logWarn("Conversation context lookup is ambiguous: multiple current destinations match.");
    return { skip: "Conversation context skipped: multiple current destinations match." };
  }
  const local = selection.conversation;
  if (local?.sessionKey) {
    return {
      destination: { sessionKey: local.sessionKey, peer: { kind: local.kind, id: local.peerId } },
      route: params.route,
    };
  }
  // `null` means the caller already proved there is no channel route.
  const route =
    params.route === null
      ? null
      : await resolveOutboundSessionRoute({
          cfg: params.config,
          channel: params.channel,
          agentId,
          accountId: params.accountId,
          target: params.to,
          threadId: params.threadId,
          assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        });
  return route
    ? { destination: route, route }
    : {
        skip: "Conversation context skipped: destination conversation could not be resolved without a network lookup.",
      };
}

// A caller-pinned conversation is the destination when the send went to its own address.
// This settles addresses that several current conversations share.
async function resolvePinnedDestination(
  params: ConfirmedVisibleMessageParams,
  agentId: string,
  storePath: string,
): Promise<ConfirmedDestination | undefined> {
  const pinnedKey = params.expectedGeneration?.sessionKey;
  if (!pinnedKey) {
    return undefined;
  }
  const sessionKey = toAgentStoreSessionKey({
    agentId,
    requestKey: pinnedKey,
    mainKey: params.config.session?.mainKey,
  });
  const entry = await readSessionEntryInWorker({
    sessionKey,
    storePath,
    readConsistency: "latest",
  });
  const context = deliveryContextFromSession(entry);
  if (context?.channel !== params.channel) {
    return undefined;
  }
  const pinned = deliveryAddressKey(params.channel, context);
  const sent = deliveryAddressKey(params.channel, {
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId ?? undefined,
  });
  return pinned && pinned === sent ? { sessionKey } : undefined;
}

// Normalizes one channel address so separately recorded contexts compare equal.
function deliveryAddressKey(
  channel: ChannelId,
  context: { to?: string; accountId?: string; threadId?: string | number } | undefined,
): string | undefined {
  if (!context?.to) {
    return undefined;
  }
  return deliveryContextKey({
    channel,
    to: context.to.trim(),
    accountId: normalizeAccountId(context.accountId),
    threadId: context.threadId ?? undefined,
  });
}

// A destination bound to another agent is not this agent's history to write.
function belongsToAgent(
  params: ConfirmedVisibleMessageParams,
  destination: ConfirmedDestination,
  agentId: string,
): boolean {
  return (
    normalizeAgentId(
      resolveAgentRoute({
        cfg: params.config,
        channel: params.channel,
        defaultAgentId: agentId,
        accountId: params.accountId,
        peer: destination.peer,
      }).agentId,
    ) === normalizeAgentId(agentId)
  );
}

// Text, media or a location can be shown as history; native-only data cannot.
function hasRecordablePayload(payload: ReplyPayload): boolean {
  return Boolean(
    normalizeOptionalString(payload.text) ||
    normalizeOptionalString(payload.spokenText) ||
    payload.mediaUrl ||
    payload.mediaUrls?.length ||
    payload.location,
  );
}
