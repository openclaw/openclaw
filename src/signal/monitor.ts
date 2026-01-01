import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { chunkText } from "../auto-reply/chunk.js";
import { danger, isVerbose, logVerbose } from "../globals.js";
import { mediaKindFromMime } from "../media/constants.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeE164 } from "../utils.js";
import { signalRpcRequest, streamSignalEvents } from "./client.js";
import { spawnSignalDaemon } from "./daemon.js";
import { sendMessageSignal } from "./send.js";

type SignalEnvelope = {
  sourceNumber?: string | null;
  sourceName?: string | null;
  timestamp?: number | null;
  dataMessage?: SignalDataMessage | null;
  editMessage?: { dataMessage?: SignalDataMessage | null } | null;
  syncMessage?: unknown | null;
};

type SignalDataMessage = {
  timestamp?: number;
  message?: string | null;
  attachments?: Array<SignalAttachment>;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
  quote?: { text?: string | null } | null;
};

type SignalAttachment = {
  id?: string | null;
  contentType?: string | null;
  filename?: string | null;
  size?: number | null;
};

export type MonitorSignalOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  account?: string;
  baseUrl?: string;
  autoStart?: boolean;
  cliPath?: string;
  httpHost?: string;
  httpPort?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  allowFrom?: Array<string | number>;
  mediaMaxMb?: number;
};

type SignalReceivePayload = {
  account?: string;
  envelope?: SignalEnvelope | null;
  exception?: { message?: string } | null;
};

function resolveRuntime(opts: MonitorSignalOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function resolveBaseUrl(opts: MonitorSignalOpts): string {
  const cfg = loadConfig();
  const signalCfg = cfg.signal;
  if (opts.baseUrl?.trim()) return opts.baseUrl.trim();
  if (signalCfg?.httpUrl?.trim()) return signalCfg.httpUrl.trim();
  const host = opts.httpHost ?? signalCfg?.httpHost ?? "127.0.0.1";
  const port = opts.httpPort ?? signalCfg?.httpPort ?? 8080;
  return `http://${host}:${port}`;
}

function resolveAccount(opts: MonitorSignalOpts): string | undefined {
  const cfg = loadConfig();
  return opts.account?.trim() || cfg.signal?.account?.trim() || undefined;
}

function resolveAllowFrom(opts: MonitorSignalOpts): string[] {
  const cfg = loadConfig();
  const raw =
    opts.allowFrom ??
    cfg.signal?.allowFrom ??
    cfg.routing?.allowFrom ??
    [];
  return raw.map((entry) => String(entry).trim()).filter(Boolean);
}

function isAllowedSender(sender: string, allowFrom: string[]): boolean {
  if (allowFrom.length === 0) return true;
  if (allowFrom.includes("*")) return true;
  const normalizedAllow = allowFrom
    .map((entry) => entry.replace(/^signal:/i, ""))
    .map((entry) => normalizeE164(entry));
  const normalizedSender = normalizeE164(sender);
  return normalizedAllow.includes(normalizedSender);
}

async function fetchAttachment(params: {
  baseUrl: string;
  account?: string;
  attachment: SignalAttachment;
  sender?: string;
  groupId?: string;
  maxBytes: number;
}): Promise<{ path: string; contentType?: string } | null> {
  const { attachment } = params;
  if (!attachment?.id) return null;
  if (attachment.size && attachment.size > params.maxBytes) {
    throw new Error(
      `Signal attachment ${attachment.id} exceeds ${(params.maxBytes / (1024 * 1024)).toFixed(0)}MB limit`,
    );
  }
  const rpcParams: Record<string, unknown> = {
    id: attachment.id,
  };
  if (params.account) rpcParams.account = params.account;
  if (params.groupId) rpcParams.groupId = params.groupId;
  else if (params.sender) rpcParams.recipient = params.sender;
  else return null;

  const result = await signalRpcRequest<{ data?: string }>(
    "getAttachment",
    rpcParams,
    { baseUrl: params.baseUrl },
  );
  if (!result?.data) return null;
  const buffer = Buffer.from(result.data, "base64");
  const saved = await saveMediaBuffer(
    buffer,
    attachment.contentType ?? undefined,
    "inbound",
    params.maxBytes,
  );
  return { path: saved.path, contentType: saved.contentType };
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  baseUrl: string;
  account?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
}) {
  const { replies, target, baseUrl, account, runtime, maxBytes } = params;
  for (const payload of replies) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;
    if (mediaList.length === 0) {
      for (const chunk of chunkText(text, 4000)) {
        await sendMessageSignal(target, chunk, {
          baseUrl,
          account,
          maxBytes,
        });
      }
    } else {
      let first = true;
      for (const url of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageSignal(target, caption, {
          baseUrl,
          account,
          mediaUrl: url,
          maxBytes,
        });
      }
    }
    runtime.log?.(`signal: delivered reply to ${target}`);
  }
}

export async function monitorSignalProvider(
  opts: MonitorSignalOpts = {},
): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = loadConfig();
  const baseUrl = resolveBaseUrl(opts);
  const account = resolveAccount(opts);
  const allowFrom = resolveAllowFrom(opts);
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.signal?.mediaMaxMb ?? 8) * 1024 * 1024;
  const ignoreAttachments =
    opts.ignoreAttachments ?? cfg.signal?.ignoreAttachments ?? false;

  const autoStart =
    opts.autoStart ??
    cfg.signal?.autoStart ??
    (cfg.signal?.httpUrl ? false : true);
  let daemonHandle: ReturnType<typeof spawnSignalDaemon> | null = null;

  if (autoStart) {
    const cliPath = opts.cliPath ?? cfg.signal?.cliPath ?? "signal-cli";
    const httpHost = opts.httpHost ?? cfg.signal?.httpHost ?? "127.0.0.1";
    const httpPort = opts.httpPort ?? cfg.signal?.httpPort ?? 8080;
    daemonHandle = spawnSignalDaemon({
      cliPath,
      account,
      httpHost,
      httpPort,
      receiveMode: opts.receiveMode ?? cfg.signal?.receiveMode,
      ignoreAttachments:
        opts.ignoreAttachments ?? cfg.signal?.ignoreAttachments,
      ignoreStories: opts.ignoreStories ?? cfg.signal?.ignoreStories,
      sendReadReceipts:
        opts.sendReadReceipts ?? cfg.signal?.sendReadReceipts,
      runtime,
    });
  }

  const onAbort = () => {
    daemonHandle?.stop();
  };
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const handleEvent = async (event: { event?: string; data?: string }) => {
      if (event.event !== "receive" || !event.data) return;
      let payload: SignalReceivePayload | null = null;
      try {
        payload = JSON.parse(event.data) as SignalReceivePayload;
      } catch (err) {
        runtime.error?.(`signal: failed to parse event: ${String(err)}`);
        return;
      }
      if (payload?.exception?.message) {
        runtime.error?.(`signal: receive exception: ${payload.exception.message}`);
      }
      const envelope = payload?.envelope;
      if (!envelope) return;
      if (envelope.syncMessage) return;
      const dataMessage =
        envelope.dataMessage ?? envelope.editMessage?.dataMessage;
      if (!dataMessage) return;

      const sender = envelope.sourceNumber?.trim();
      if (!sender) return;
      if (account && normalizeE164(sender) === normalizeE164(account)) {
        return;
      }
      if (!isAllowedSender(sender, allowFrom)) {
        logVerbose(`Blocked signal sender ${sender} (not in allowFrom)`);
        return;
      }

      const groupId = dataMessage.groupInfo?.groupId ?? undefined;
      const groupName = dataMessage.groupInfo?.groupName ?? undefined;
      const isGroup = Boolean(groupId);
      const messageText = (dataMessage.message ?? "").trim();

      let mediaPath: string | undefined;
      let mediaType: string | undefined;
      let placeholder = "";
      const firstAttachment = dataMessage.attachments?.[0];
      if (firstAttachment?.id && !ignoreAttachments) {
        try {
          const fetched = await fetchAttachment({
            baseUrl,
            account,
            attachment: firstAttachment,
            sender,
            groupId,
            maxBytes: mediaMaxBytes,
          });
          if (fetched) {
            mediaPath = fetched.path;
            mediaType = fetched.contentType ?? firstAttachment.contentType ?? undefined;
          }
        } catch (err) {
          runtime.error?.(
            danger(`signal: attachment fetch failed: ${String(err)}`),
          );
        }
      }

      const kind = mediaKindFromMime(mediaType ?? undefined);
      if (kind) {
        placeholder = `<media:${kind}>`;
      } else if (dataMessage.attachments?.length) {
        placeholder = "<media:attachment>";
      }

      const bodyText =
        messageText || placeholder || dataMessage.quote?.text?.trim() || "";
      if (!bodyText) return;

      const fromLabel = isGroup
        ? `${groupName ?? "Signal Group"} id:${groupId}`
        : `${envelope.sourceName ?? sender} id:${sender}`;
      const body = formatAgentEnvelope({
        surface: "Signal",
        from: fromLabel,
        timestamp: envelope.timestamp ?? undefined,
        body: bodyText,
      });

      const ctxPayload = {
        Body: body,
        From: isGroup ? `group:${groupId}` : `signal:${sender}`,
        To: isGroup ? `group:${groupId}` : `signal:${sender}`,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? groupName ?? undefined : undefined,
        SenderName: envelope.sourceName ?? sender,
        Surface: "signal" as const,
        MessageSid: envelope.timestamp ? String(envelope.timestamp) : undefined,
        Timestamp: envelope.timestamp ?? undefined,
        MediaPath: mediaPath,
        MediaType: mediaType,
        MediaUrl: mediaPath,
      };

      if (!isGroup) {
        const sessionCfg = cfg.session;
        const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
        const storePath = resolveStorePath(sessionCfg?.store);
        await updateLastRoute({
          storePath,
          sessionKey: mainKey,
          channel: "signal",
          to: normalizeE164(sender),
        });
      }

      if (isVerbose()) {
        const preview = body.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
        );
      }

      const replyResult = await getReplyFromConfig(ctxPayload, undefined, cfg);
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      if (replies.length === 0) return;

      await deliverReplies({
        replies,
        target: ctxPayload.To,
        baseUrl,
        account,
        runtime,
        maxBytes: mediaMaxBytes,
      });
    };

    await streamSignalEvents({
      baseUrl,
      account,
      abortSignal: opts.abortSignal,
      onEvent: (event) => {
        void handleEvent(event).catch((err) => {
          runtime.error?.(`signal: event handler failed: ${String(err)}`);
        });
      },
    });
  } catch (err) {
    if (opts.abortSignal?.aborted) return;
    throw err;
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
    daemonHandle?.stop();
  }
}
