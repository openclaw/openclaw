import fs from "node:fs/promises";
import { resolveHumanDelayConfig } from "../../agents/identity.js";
import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import {
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "../../auto-reply/reply/history.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import { loadConfig } from "../../config/config.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { waitForTransportReady } from "../../infra/transport-ready.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveIMessageAccount } from "../accounts.js";
import { createIMessageRpcClient } from "../client.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "../constants.js";
import { probeIMessage } from "../probe.js";
import { sendMessageIMessage } from "../send.js";
import { attachIMessageMonitorAbortHandler } from "./abort-handler.js";
import { deliverReplies } from "./deliver.js";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { parseIMessageNotification } from "./parse-notification.js";
import { normalizeAllowList, resolveRuntime } from "./runtime.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./types.js";

/**
 * Try to detect remote host from an SSH wrapper script like:
 *   exec ssh -T openclaw@192.168.64.3 /opt/homebrew/bin/imsg "$@"
 *   exec ssh -T mac-mini imsg "$@"
 * Returns the user@host or host portion if found, undefined otherwise.
 */
async function detectRemoteHostFromCliPath(cliPath: string): Promise<string | undefined> {
  try {
    // Expand ~ to home directory
    const expanded = cliPath.startsWith("~")
      ? cliPath.replace(/^~/, process.env.HOME ?? "")
      : cliPath;
    const content = await fs.readFile(expanded, "utf8");

    // Match user@host pattern first (e.g., openclaw@192.168.64.3)
    const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
    if (userHostMatch) {
      return userHostMatch[1];
    }

    // Fallback: match host-only before imsg command (e.g., ssh -T mac-mini imsg)
    const hostOnlyMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/);
    return hostOnlyMatch?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Cache for recently sent messages, used for echo detection.
 * Keys are scoped by conversation (accountId:target) so the same text in different chats is not conflated.
 * Entries expire after 5 seconds; we do not forget on match so multiple echo deliveries are all filtered.
 */
class SentMessageCache {
  private cache = new Map<string, number>();
  private readonly ttlMs = 5000; // 5 seconds

  remember(scope: string, text: string): void {
    if (!text?.trim()) {
      return;
    }
    const key = `${scope}:${text.trim()}`;
    this.cache.set(key, Date.now());
    this.cleanup();
  }

  has(scope: string, text: string): boolean {
    if (!text?.trim()) {
      return false;
    }
    const key = `${scope}:${text.trim()}`;
    const timestamp = this.cache.get(key);
    if (!timestamp) {
      return false;
    }
    const age = Date.now() - timestamp;
    if (age > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [text, timestamp] of this.cache.entries()) {
      if (now - timestamp > this.ttlMs) {
        this.cache.delete(text);
      }
    }
  }
}

export async function monitorIMessageProvider(opts: MonitorIMessageOpts = {}): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? loadConfig();
  const accountInfo = resolveIMessageAccount({
    cfg,
    accountId: opts.accountId,
  });
  const imessageCfg = accountInfo.config;
  const historyLimit = Math.max(
    0,
    imessageCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const sentMessageCache = new SentMessageCache();
  const textLimit = resolveTextChunkLimit(cfg, "imessage", accountInfo.accountId);
  const allowFrom = normalizeAllowList(opts.allowFrom ?? imessageCfg.allowFrom);
  const groupAllowFrom = normalizeAllowList(
    opts.groupAllowFrom ??
      imessageCfg.groupAllowFrom ??
      (imessageCfg.allowFrom && imessageCfg.allowFrom.length > 0 ? imessageCfg.allowFrom : []),
  );
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = imessageCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
  const dmPolicy = imessageCfg.dmPolicy ?? "pairing";
  const includeAttachments = opts.includeAttachments ?? imessageCfg.includeAttachments ?? false;
  const mediaMaxBytes = (opts.mediaMaxMb ?? imessageCfg.mediaMaxMb ?? 16) * 1024 * 1024;
  const cliPath = opts.cliPath ?? imessageCfg.cliPath ?? "imsg";
  const dbPath = opts.dbPath ?? imessageCfg.dbPath;
  const probeTimeoutMs = imessageCfg.probeTimeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;

  // Resolve remoteHost: explicit config, or auto-detect from SSH wrapper script
  let remoteHost = imessageCfg.remoteHost;
  if (!remoteHost && cliPath && cliPath !== "imsg") {
    remoteHost = await detectRemoteHostFromCliPath(cliPath);
    if (remoteHost) {
      logVerbose(`imessage: detected remoteHost=${remoteHost} from cliPath`);
    }
  }

  const inboundDebounceMs = resolveInboundDebounceMs({ cfg, channel: "imessage" });
  const inboundDebouncer = createInboundDebouncer<{ message: IMessagePayload }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const sender = entry.message.sender?.trim();
      if (!sender) {
        return null;
      }
      const conversationId =
        entry.message.chat_id != null
          ? `chat:${entry.message.chat_id}`
          : (entry.message.chat_guid ?? entry.message.chat_identifier ?? "unknown");
      return `imessage:${accountInfo.accountId}:${conversationId}:${sender}`;
    },
    shouldDebounce: (entry) => {
      const text = entry.message.text?.trim() ?? "";
      if (!text) {
        return false;
      }
      if (entry.message.attachments && entry.message.attachments.length > 0) {
        return false;
      }
      return !hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleMessageNow(last.message);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.message.text ?? "")
        .filter(Boolean)
        .join("\n");
      const syntheticMessage: IMessagePayload = {
        ...last.message,
        text: combinedText,
        attachments: null,
      };
      await handleMessageNow(syntheticMessage);
    },
    onError: (err) => {
      runtime.error?.(`imessage debounce flush failed: ${String(err)}`);
    },
  });

  async function handleMessageNow(message: IMessagePayload) {
    const messageText = (message.text ?? "").trim();

    const attachments = includeAttachments ? (message.attachments ?? []) : [];
    // Filter to valid attachments with paths
    const validAttachments = attachments.filter((entry) => entry?.original_path && !entry?.missing);
    const firstAttachment = validAttachments[0];
    const mediaPath = firstAttachment?.original_path ?? undefined;
    const mediaType = firstAttachment?.mime_type ?? undefined;
    // Build arrays for all attachments (for multi-image support)
    const mediaPaths = validAttachments.map((a) => a.original_path).filter(Boolean) as string[];
    const mediaTypes = validAttachments.map((a) => a.mime_type ?? undefined);
    const kind = mediaKindFromMime(mediaType ?? undefined);
    const placeholder = kind ? `<media:${kind}>` : attachments?.length ? "<media:attachment>" : "";
    const bodyText = messageText || placeholder;

    const storeAllowFrom = await readChannelAllowFromStore("imessage").catch(() => []);
    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: accountInfo.accountId,
      message,
      opts,
      messageText,
      bodyText,
      allowFrom,
      groupAllowFrom,
      groupPolicy,
      dmPolicy,
      storeAllowFrom,
      historyLimit,
      groupHistories,
      echoCache: sentMessageCache,
      logVerbose,
    });

    if (decision.kind === "drop") {
      return;
    }

    const chatId = message.chat_id ?? undefined;
    if (decision.kind === "pairing") {
      const sender = (message.sender ?? "").trim();
      if (!sender) {
        return;
      }
      const { code, created } = await upsertChannelPairingRequest({
        channel: "imessage",
        id: decision.senderId,
        meta: {
          sender: decision.senderId,
          chatId: chatId ? String(chatId) : undefined,
        },
      });
      if (created) {
        logVerbose(`imessage pairing request sender=${decision.senderId}`);
        try {
          await sendMessageIMessage(
            sender,
            buildPairingReply({
              channel: "imessage",
              idLine: `Your iMessage sender id: ${decision.senderId}`,
              code,
            }),
            {
              client,
              maxBytes: mediaMaxBytes,
              accountId: accountInfo.accountId,
              ...(chatId ? { chatId } : {}),
            },
          );
        } catch (err) {
          logVerbose(`imessage pairing reply failed for ${decision.senderId}: ${String(err)}`);
        }
      }
      return;
    }

    const storePath = resolveStorePath(cfg.session?.store, {
      agentId: decision.route.agentId,
    });
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: decision.route.sessionKey,
    });
    const { ctxPayload, chatTarget } = buildIMessageInboundContext({
      cfg,
      decision,
      message,
      previousTimestamp,
      remoteHost,
      historyLimit,
      groupHistories,
      media: {
        path: mediaPath,
        type: mediaType,
        paths: mediaPaths,
        types: mediaTypes,
      },
    });

    const updateTarget = chatTarget || decision.sender;
    await recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? decision.route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute:
        !decision.isGroup && updateTarget
          ? {
              sessionKey: decision.route.mainSessionKey,
              channel: "imessage",
              to: updateTarget,
              accountId: decision.route.accountId,
            }
          : undefined,
      onRecordError: (err) => {
        logVerbose(`imessage: failed updating session meta: ${String(err)}`);
      },
    });

    if (shouldLogVerbose()) {
      const preview = truncateUtf16Safe(String(ctxPayload.Body ?? ""), 200).replace(/\n/g, "\\n");
      logVerbose(
        `imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${
          String(ctxPayload.Body ?? "").length
        } preview="${preview}"`,
      );
    }

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: decision.route.agentId,
      channel: "imessage",
      accountId: decision.route.accountId,
    });

    const dispatcher = createReplyDispatcher({
      ...prefixOptions,
      humanDelay: resolveHumanDelayConfig(cfg, decision.route.agentId),
      deliver: async (payload) => {
        const target = ctxPayload.To;
        if (!target) {
          runtime.error?.(danger("imessage: missing delivery target"));
          return;
        }
        await deliverReplies({
          replies: [payload],
          target,
          client,
          accountId: accountInfo.accountId,
          runtime,
          maxBytes: mediaMaxBytes,
          textLimit,
          sentMessageCache,
        });
      },
      onError: (err, info) => {
        runtime.error?.(danger(`imessage ${info.kind} reply failed: ${String(err)}`));
      },
    });

    const { queuedFinal } = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming:
          typeof accountInfo.config.blockStreaming === "boolean"
            ? !accountInfo.config.blockStreaming
            : undefined,
        onModelSelected,
      },
    });

    if (!queuedFinal) {
      if (decision.isGroup && decision.historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: groupHistories,
          historyKey: decision.historyKey,
          limit: historyLimit,
        });
      }
      return;
    }
    if (decision.isGroup && decision.historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: groupHistories,
        historyKey: decision.historyKey,
        limit: historyLimit,
      });
    }
  }

  const handleMessage = async (raw: unknown) => {
    const message = parseIMessageNotification(raw);
    if (!message) {
      logVerbose("imessage: dropping malformed RPC message payload");
      return;
    }
    await inboundDebouncer.enqueue({ message });
  };

  await waitForTransportReady({
    label: "imsg rpc",
    timeoutMs: 30_000,
    logAfterMs: 10_000,
    logIntervalMs: 10_000,
    pollIntervalMs: 500,
    abortSignal: opts.abortSignal,
    runtime,
    check: async () => {
      const probe = await probeIMessage(probeTimeoutMs, { cliPath, dbPath, runtime });
      if (probe.ok) {
        return { ok: true };
      }
      if (probe.fatal) {
        throw new Error(probe.error ?? "imsg rpc unavailable");
      }
      return { ok: false, error: probe.error ?? "unreachable" };
    },
  });

  if (opts.abortSignal?.aborted) {
    return;
  }

  const client = await createIMessageRpcClient({
    cliPath,
    dbPath,
    runtime,
    onNotification: (msg) => {
      if (msg.method === "message") {
        void handleMessage(msg.params).catch((err) => {
          runtime.error?.(`imessage: handler failed: ${String(err)}`);
        });
      } else if (msg.method === "error") {
        runtime.error?.(`imessage: watch error ${JSON.stringify(msg.params)}`);
      }
    },
  });

  let subscriptionId: number | null = null;
  const abort = opts.abortSignal;
  const detachAbortHandler = attachIMessageMonitorAbortHandler({
    abortSignal: abort,
    client,
    getSubscriptionId: () => subscriptionId,
  });

  try {
    const result = await client.request<{ subscription?: number }>("watch.subscribe", {
      attachments: includeAttachments,
    });
    subscriptionId = result?.subscription ?? null;
    await client.waitForClose();
  } catch (err) {
    if (abort?.aborted) {
      return;
    }
    runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
    throw err;
  } finally {
    detachAbortHandler();
    await client.stop();
  }
}
