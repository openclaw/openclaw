import { loadConfig } from "../config/config.js";
import { mediaKindFromMime } from "../media/constants.js";
import { saveMediaBuffer } from "../media/store.js";
import { loadWebMedia } from "../web/media.js";
import { signalRpcRequest } from "./client.js";

export type SignalSendOpts = {
  baseUrl?: string;
  account?: string;
  mediaUrl?: string;
  maxBytes?: number;
  timeoutMs?: number;
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
};

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

function resolveBaseUrl(explicit?: string): string {
  const cfg = loadConfig();
  const signalCfg = cfg.signal;
  if (explicit?.trim()) return explicit.trim();
  if (signalCfg?.httpUrl?.trim()) return signalCfg.httpUrl.trim();
  const host = signalCfg?.httpHost?.trim() || "127.0.0.1";
  const port = signalCfg?.httpPort ?? 8080;
  return `http://${host}:${port}`;
}

function resolveAccount(explicit?: string): string | undefined {
  const cfg = loadConfig();
  const signalCfg = cfg.signal;
  const account = explicit?.trim() || signalCfg?.account?.trim();
  return account || undefined;
}

function parseTarget(raw: string): SignalTarget {
  let value = raw.trim();
  if (!value) throw new Error("Signal recipient is required");
  const lower = value.toLowerCase();
  if (lower.startsWith("group:")) {
    return { type: "group", groupId: value.slice("group:".length).trim() };
  }
  if (lower.startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  if (lower.startsWith("username:")) {
    return { type: "username", username: value.slice("username:".length).trim() };
  }
  if (lower.startsWith("u:")) {
    return { type: "username", username: value.trim() };
  }
  return { type: "recipient", recipient: value };
}

async function resolveAttachment(
  mediaUrl: string,
  maxBytes: number,
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(mediaUrl, maxBytes);
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
  );
  return { path: saved.path, contentType: saved.contentType };
}

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts = {},
): Promise<SignalSendResult> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const account = resolveAccount(opts.account);
  const target = parseTarget(to);
  let message = text ?? "";
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;

  let attachments: string[] | undefined;
  if (opts.mediaUrl?.trim()) {
    const resolved = await resolveAttachment(opts.mediaUrl.trim(), maxBytes);
    attachments = [resolved.path];
    const kind = mediaKindFromMime(resolved.contentType ?? undefined);
    if (!message && kind) {
      // Avoid sending an empty body when only attachments exist.
      message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
    }
  }

  if (!message.trim() && (!attachments || attachments.length === 0)) {
    throw new Error("Signal send requires text or media");
  }

  const params: Record<string, unknown> = { message };
  if (account) params.account = account;
  if (attachments && attachments.length > 0) {
    params.attachments = attachments;
  }

  if (target.type === "recipient") {
    params.recipient = [target.recipient];
  } else if (target.type === "group") {
    params.groupId = target.groupId;
  } else if (target.type === "username") {
    params.username = [target.username];
  }

  const result = await signalRpcRequest<{ timestamp?: number }>(
    "send",
    params,
    { baseUrl, timeoutMs: opts.timeoutMs },
  );
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}
