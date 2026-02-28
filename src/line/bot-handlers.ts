import type {
  WebhookEvent,
  MessageEvent,
  FollowEvent,
  UnfollowEvent,
  JoinEvent,
  LeaveEvent,
  PostbackEvent,
} from "@line/bot-sdk";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { resolveControlCommandGate } from "../channels/command-gating.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  normalizeNonTelegramGroupPolicy,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
import { danger, logVerbose } from "../globals.js";
import { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  firstDefined,
  isSenderAllowed,
  normalizeAllowFrom,
  normalizeDmAllowFromWithStore,
} from "./bot-access.js";
import {
  getLineSourceInfo,
  buildLineMessageContext,
  buildLinePostbackContext,
  type LineInboundContext,
} from "./bot-message-context.js";
import { downloadLineMedia } from "./download.js";
import { pushMessageLine, replyMessageLine } from "./send.js";
import type { LineGroupConfig, ResolvedLineAccount } from "./types.js";

interface MediaRef {
  path: string;
  contentType?: string;
}

const LINE_DOWNLOADABLE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "file",
]);

function isDownloadableLineMessageType(
  messageType: MessageEvent["message"]["type"],
): messageType is "image" | "video" | "audio" | "file" {
  return LINE_DOWNLOADABLE_MESSAGE_TYPES.has(messageType);
}

export interface LineHandlerContext {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  runtime: RuntimeEnv;
  mediaMaxBytes: number;
  processMessage: (ctx: LineInboundContext) => Promise<void>;
  replayCache?: LineWebhookReplayCache;
}

const LINE_WEBHOOK_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const LINE_WEBHOOK_REPLAY_MAX_ENTRIES = 4096;
const LINE_WEBHOOK_REPLAY_PRUNE_INTERVAL_MS = 1000;
export type LineWebhookReplayCache = {
  seenEvents: Map<string, number>;
  inFlightEvents: Map<string, Promise<void>>;
  lastPruneAtMs: number;
};

export function createLineWebhookReplayCache(): LineWebhookReplayCache {
  return {
    seenEvents: new Map<string, number>(),
    inFlightEvents: new Map<string, Promise<void>>(),
    lastPruneAtMs: 0,
  };
}

function pruneLineWebhookReplayCache(cache: LineWebhookReplayCache, nowMs: number): void {
  const minSeenAt = nowMs - LINE_WEBHOOK_REPLAY_WINDOW_MS;
  for (const [key, seenAt] of cache.seenEvents) {
    if (seenAt < minSeenAt) {
      cache.seenEvents.delete(key);
    }
  }

  if (cache.seenEvents.size > LINE_WEBHOOK_REPLAY_MAX_ENTRIES) {
    const deleteCount = cache.seenEvents.size - LINE_WEBHOOK_REPLAY_MAX_ENTRIES;
    let deleted = 0;
    for (const key of cache.seenEvents.keys()) {
      if (deleted >= deleteCount) {
        break;
      }
      cache.seenEvents.delete(key);
      deleted += 1;
    }
  }
}

function buildLineWebhookReplayKey(
  event: WebhookEvent,
  accountId: string,
): { key: string; eventId: string } | null {
  if (event.type === "message") {
    const messageId = event.message?.id?.trim();
    if (messageId) {
      return {
        key: `${accountId}|message:${messageId}`,
        eventId: `message:${messageId}`,
      };
    }
  }
  const eventId = (event as { webhookEventId?: string }).webhookEventId?.trim();
  if (!eventId) {
    return null;
  }

  const source = (
    event as {
      source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
    }
  ).source;
  const sourceId =
    source?.type === "group"
      ? `group:${source.groupId ?? ""}`
      : source?.type === "room"
        ? `room:${source.roomId ?? ""}`
        : `user:${source?.userId ?? ""}`;
  return { key: `${accountId}|${event.type}|${sourceId}|${eventId}`, eventId: `event:${eventId}` };
}

type LineReplayCandidate = {
  key: string;
  eventId: string;
  seenAtMs: number;
  cache: LineWebhookReplayCache;
};

type LineInFlightReplayResult = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
};

function getLineReplayCandidate(
  event: WebhookEvent,
  context: LineHandlerContext,
): LineReplayCandidate | null {
  const replay = buildLineWebhookReplayKey(event, context.account.accountId);
  const cache = context.replayCache;
  if (!replay || !cache) {
    return null;
  }

  const nowMs = Date.now();
  if (
    nowMs - cache.lastPruneAtMs >= LINE_WEBHOOK_REPLAY_PRUNE_INTERVAL_MS ||
    cache.seenEvents.size >= LINE_WEBHOOK_REPLAY_MAX_ENTRIES
  ) {
    pruneLineWebhookReplayCache(cache, nowMs);
    cache.lastPruneAtMs = nowMs;
  }
  return { key: replay.key, eventId: replay.eventId, seenAtMs: nowMs, cache };
}

function shouldSkipLineReplayEvent(
  candidate: LineReplayCandidate,
): { skip: true; inFlightResult?: Promise<void> } | { skip: false } {
  const inFlightResult = candidate.cache.inFlightEvents.get(candidate.key);
  if (inFlightResult) {
    logVerbose(`line: skipped in-flight replayed webhook event ${candidate.eventId}`);
    return { skip: true, inFlightResult };
  }
  if (candidate.cache.seenEvents.has(candidate.key)) {
    logVerbose(`line: skipped replayed webhook event ${candidate.eventId}`);
    return { skip: true };
  }
  return { skip: false };
}

function markLineReplayEventInFlight(candidate: LineReplayCandidate): LineInFlightReplayResult {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Prevent unhandled rejection warnings when no concurrent duplicate awaits
  // this in-flight reservation.
  void promise.catch(() => {});
  candidate.cache.inFlightEvents.set(candidate.key, promise);
  return { promise, resolve, reject };
}

function clearLineReplayEventInFlight(candidate: LineReplayCandidate): void {
  candidate.cache.inFlightEvents.delete(candidate.key);
}

function rememberLineReplayEvent(candidate: LineReplayCandidate): void {
  candidate.cache.seenEvents.set(candidate.key, candidate.seenAtMs);
}

function resolveLineGroupConfig(params: {
  config: ResolvedLineAccount["config"];
  groupId?: string;
  roomId?: string;
}): LineGroupConfig | undefined {
  const groups = params.config.groups ?? {};
  if (params.groupId) {
    return groups[params.groupId] ?? groups[`group:${params.groupId}`] ?? groups["*"];
  }
  if (params.roomId) {
    return groups[params.roomId] ?? groups[`room:${params.roomId}`] ?? groups["*"];
  }
  return groups["*"];
}

async function sendLinePairingReply(params: {
  senderId: string;
  replyToken?: string;
  context: LineHandlerContext;
}): Promise<void> {
  const { senderId, replyToken, context } = params;
  const { code, created } = await upsertChannelPairingRequest({
    channel: "line",
    id: senderId,
    accountId: context.account.accountId,
  });
  if (!created) {
    return;
  }
  logVerbose(`line pairing request sender=${senderId}`);
  const idLabel = (() => {
    try {
      return resolvePairingIdLabel("line");
    } catch {
      return "lineUserId";
    }
  })();
  const text = buildPairingReply({
    channel: "line",
    idLine: `Your ${idLabel}: ${senderId}`,
    code,
  });
  try {
    if (replyToken) {
      await replyMessageLine(replyToken, [{ type: "text", text }], {
        accountId: context.account.accountId,
        channelAccessToken: context.account.channelAccessToken,
      });
      return;
    }
  } catch (err) {
    logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
  }
  try {
    await pushMessageLine(`line:${senderId}`, text, {
      accountId: context.account.accountId,
      channelAccessToken: context.account.channelAccessToken,
    });
  } catch (err) {
    logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
  }
}

async function shouldProcessLineEvent(
  event: MessageEvent | PostbackEvent,
  context: LineHandlerContext,
): Promise<{ allowed: boolean; commandAuthorized: boolean }> {
  const denied = { allowed: false, commandAuthorized: false };
  const { cfg, account } = context;
  const { userId, groupId, roomId, isGroup } = getLineSourceInfo(event.source);
  const senderId = userId ?? "";
  const dmPolicy = account.config.dmPolicy ?? "pairing";

  const storeAllowFrom = await readChannelAllowFromStore(
    "line",
    undefined,
    account.accountId,
  ).catch(() => []);
  const effectiveDmAllow = normalizeDmAllowFromWithStore({
    allowFrom: account.config.allowFrom,
    storeAllowFrom,
    dmPolicy,
  });
  const groupConfig = resolveLineGroupConfig({ config: account.config, groupId, roomId });
  const groupAllowOverride = groupConfig?.allowFrom;
  const fallbackGroupAllowFrom = account.config.allowFrom?.length
    ? account.config.allowFrom
    : undefined;
  const defaultGroupAllowFrom = cfg.channels?.defaults?.groupAllowFrom;
  const groupAllowFrom = firstDefined(
    groupAllowOverride,
    account.config.groupAllowFrom,
    defaultGroupAllowFrom,
    fallbackGroupAllowFrom,
  );
  // Group sender policy must be derived from explicit group config only.
  // Pairing store entries are DM-oriented and must not expand group allowlists.
  const effectiveGroupAllow = normalizeAllowFrom(groupAllowFrom);
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy: rawGroupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.line !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  // "members" is Telegram-only; normalize to "open" for Line
  const groupPolicy = normalizeNonTelegramGroupPolicy(rawGroupPolicy);
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "line",
    accountId: account.accountId,
    log: (message) => logVerbose(message),
  });

  if (isGroup) {
    if (groupConfig?.enabled === false) {
      logVerbose(`Blocked line group ${groupId ?? roomId ?? "unknown"} (group disabled)`);
      return denied;
    }
    if (typeof groupAllowOverride !== "undefined") {
      if (!senderId) {
        logVerbose("Blocked line group message (group allowFrom override, no sender ID)");
        return denied;
      }
      if (!isSenderAllowed({ allow: effectiveGroupAllow, senderId })) {
        logVerbose(`Blocked line group sender ${senderId} (group allowFrom override)`);
        return denied;
      }
    }
    if (groupPolicy === "disabled") {
      logVerbose("Blocked line group message (groupPolicy: disabled)");
      return denied;
    }
    if (groupPolicy === "allowlist") {
      if (!senderId) {
        logVerbose("Blocked line group message (no sender ID, groupPolicy: allowlist)");
        return denied;
      }
      if (!effectiveGroupAllow.hasEntries) {
        logVerbose("Blocked line group message (groupPolicy: allowlist, no groupAllowFrom)");
        return denied;
      }
      if (!isSenderAllowed({ allow: effectiveGroupAllow, senderId })) {
        logVerbose(`Blocked line group message from ${senderId} (groupPolicy: allowlist)`);
        return denied;
      }
    }
    const allowForCommands = effectiveGroupAllow;
    const senderAllowedForCommands = isSenderAllowed({ allow: allowForCommands, senderId });
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const rawText = resolveEventRawText(event);
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [{ configured: allowForCommands.hasEntries, allowed: senderAllowedForCommands }],
      allowTextCommands: true,
      hasControlCommand: hasControlCommand(rawText, cfg),
    });
    return { allowed: true, commandAuthorized: commandGate.commandAuthorized };
  }

  if (dmPolicy === "disabled") {
    logVerbose("Blocked line sender (dmPolicy: disabled)");
    return denied;
  }

  const dmAllowed = dmPolicy === "open" || isSenderAllowed({ allow: effectiveDmAllow, senderId });
  if (!dmAllowed) {
    if (dmPolicy === "pairing") {
      if (!senderId) {
        logVerbose("Blocked line sender (dmPolicy: pairing, no sender ID)");
        return denied;
      }
      await sendLinePairingReply({
        senderId,
        replyToken: "replyToken" in event ? event.replyToken : undefined,
        context,
      });
    } else {
      logVerbose(`Blocked line sender ${senderId || "unknown"} (dmPolicy: ${dmPolicy})`);
    }
    return denied;
  }

  const allowForCommands = effectiveDmAllow;
  const senderAllowedForCommands = isSenderAllowed({ allow: allowForCommands, senderId });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const rawText = resolveEventRawText(event);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [{ configured: allowForCommands.hasEntries, allowed: senderAllowedForCommands }],
    allowTextCommands: true,
    hasControlCommand: hasControlCommand(rawText, cfg),
  });
  return { allowed: true, commandAuthorized: commandGate.commandAuthorized };
}

function resolveEventRawText(event: MessageEvent | PostbackEvent): string {
  if (event.type === "message") {
    const msg = event.message;
    if (msg.type === "text") {
      return msg.text;
    }
    return "";
  }
  if (event.type === "postback") {
    return event.postback?.data?.trim() ?? "";
  }
  return "";
}

async function handleMessageEvent(event: MessageEvent, context: LineHandlerContext): Promise<void> {
  const { cfg, account, runtime, mediaMaxBytes, processMessage } = context;
  const message = event.message;

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision.allowed) {
    return;
  }

  // Download media if applicable
  const allMedia: MediaRef[] = [];

  if (isDownloadableLineMessageType(message.type)) {
    try {
      const media = await downloadLineMedia(message.id, account.channelAccessToken, mediaMaxBytes);
      allMedia.push({
        path: media.path,
        contentType: media.contentType,
      });
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes("exceeds") && errMsg.includes("limit")) {
        logVerbose(`line: media exceeds size limit for message ${message.id}`);
        // Continue without media
      } else {
        runtime.error?.(danger(`line: failed to download media: ${errMsg}`));
      }
    }
  }

  const messageContext = await buildLineMessageContext({
    event,
    allMedia,
    cfg,
    account,
    commandAuthorized: decision.commandAuthorized,
  });

  if (!messageContext) {
    logVerbose("line: skipping empty message");
    return;
  }

  await processMessage(messageContext);
}

async function handleFollowEvent(event: FollowEvent, _context: LineHandlerContext): Promise<void> {
  const userId = event.source.type === "user" ? event.source.userId : undefined;
  logVerbose(`line: user ${userId ?? "unknown"} followed`);
  // Could implement welcome message here
}

async function handleUnfollowEvent(
  event: UnfollowEvent,
  _context: LineHandlerContext,
): Promise<void> {
  const userId = event.source.type === "user" ? event.source.userId : undefined;
  logVerbose(`line: user ${userId ?? "unknown"} unfollowed`);
}

async function handleJoinEvent(event: JoinEvent, _context: LineHandlerContext): Promise<void> {
  const groupId = event.source.type === "group" ? event.source.groupId : undefined;
  const roomId = event.source.type === "room" ? event.source.roomId : undefined;
  logVerbose(`line: bot joined ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handleLeaveEvent(event: LeaveEvent, _context: LineHandlerContext): Promise<void> {
  const groupId = event.source.type === "group" ? event.source.groupId : undefined;
  const roomId = event.source.type === "room" ? event.source.roomId : undefined;
  logVerbose(`line: bot left ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handlePostbackEvent(
  event: PostbackEvent,
  context: LineHandlerContext,
): Promise<void> {
  const data = event.postback.data;
  logVerbose(`line: received postback: ${data}`);

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision.allowed) {
    return;
  }

  const postbackContext = await buildLinePostbackContext({
    event,
    cfg: context.cfg,
    account: context.account,
    commandAuthorized: decision.commandAuthorized,
  });
  if (!postbackContext) {
    return;
  }

  await context.processMessage(postbackContext);
}

export async function handleLineWebhookEvents(
  events: WebhookEvent[],
  context: LineHandlerContext,
): Promise<void> {
  let firstError: unknown;
  for (const event of events) {
    const replayCandidate = getLineReplayCandidate(event, context);
    const replaySkip = replayCandidate ? shouldSkipLineReplayEvent(replayCandidate) : null;
    if (replaySkip?.skip) {
      if (replaySkip.inFlightResult) {
        try {
          await replaySkip.inFlightResult;
        } catch (err) {
          context.runtime.error?.(danger(`line: replayed in-flight event failed: ${String(err)}`));
          firstError ??= err;
        }
      }
      continue;
    }
    const inFlightReservation = replayCandidate
      ? markLineReplayEventInFlight(replayCandidate)
      : null;
    try {
      switch (event.type) {
        case "message":
          await handleMessageEvent(event, context);
          break;
        case "follow":
          await handleFollowEvent(event, context);
          break;
        case "unfollow":
          await handleUnfollowEvent(event, context);
          break;
        case "join":
          await handleJoinEvent(event, context);
          break;
        case "leave":
          await handleLeaveEvent(event, context);
          break;
        case "postback":
          await handlePostbackEvent(event, context);
          break;
        default:
          logVerbose(`line: unhandled event type: ${(event as WebhookEvent).type}`);
      }
      if (replayCandidate) {
        rememberLineReplayEvent(replayCandidate);
        inFlightReservation?.resolve();
        clearLineReplayEventInFlight(replayCandidate);
      }
    } catch (err) {
      if (replayCandidate) {
        inFlightReservation?.reject(err);
        clearLineReplayEventInFlight(replayCandidate);
      }
      context.runtime.error?.(danger(`line: event handler failed: ${String(err)}`));
      firstError ??= err;
    }
  }
  if (firstError) {
    throw firstError;
  }
}
