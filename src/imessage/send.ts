import { loadConfig } from "../config/config.js";
import { mediaKindFromMime } from "../media/constants.js";
import { saveMediaBuffer } from "../media/store.js";
import { loadWebMedia } from "../web/media.js";
import { resolveIMessageAccount } from "./accounts.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import { formatIMessageChatTarget, type IMessageService, parseIMessageTarget } from "./targets.js";

export type IMessageSendOpts = {
  cliPath?: string;
  dbPath?: string;
  service?: IMessageService;
  region?: string;
  accountId?: string;
  mediaUrl?: string;
  maxBytes?: number;
  timeoutMs?: number;
  chatId?: number;
  client?: IMessageRpcClient;
};

export type IMessageSendResult = {
  messageId: string;
};

function resolveMessageId(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) return null;
  const raw =
    (typeof result.messageId === "string" && result.messageId.trim()) ||
    (typeof result.message_id === "string" && result.message_id.trim()) ||
    (typeof result.id === "string" && result.id.trim()) ||
    (typeof result.guid === "string" && result.guid.trim()) ||
    (typeof result.message_id === "number" ? String(result.message_id) : null) ||
    (typeof result.id === "number" ? String(result.id) : null);
  return raw ? String(raw).trim() : null;
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

export async function sendMessageIMessage(
  to: string,
  text: string,
  opts: IMessageSendOpts = {},
): Promise<IMessageSendResult> {
  const cfg = loadConfig();
  const account = resolveIMessageAccount({
    cfg,
    accountId: opts.accountId,
  });
  const cliPath = opts.cliPath?.trim() || account.config.cliPath?.trim() || "imsg";
  const dbPath = opts.dbPath?.trim() || account.config.dbPath?.trim();
  const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
  const service =
    opts.service ??
    (target.kind === "handle" ? target.service : undefined) ??
    (account.config.service as IMessageService | undefined);
  const region = opts.region?.trim() || account.config.region?.trim() || "US";
  const maxBytes =
    typeof opts.maxBytes === "number"
      ? opts.maxBytes
      : typeof account.config.mediaMaxMb === "number"
        ? account.config.mediaMaxMb * 1024 * 1024
        : 16 * 1024 * 1024;
  let message = text ?? "";
  let filePath: string | undefined;

  if (opts.mediaUrl?.trim()) {
    const resolved = await resolveAttachment(opts.mediaUrl.trim(), maxBytes);
    filePath = resolved.path;
    if (!message.trim()) {
      const kind = mediaKindFromMime(resolved.contentType ?? undefined);
      if (kind) message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
    }
  }

  if (!message.trim() && !filePath) {
    throw new Error("iMessage send requires text or media");
  }

  const params: Record<string, unknown> = {
    text: message,
    service: (service || "auto") as IMessageService,
    region,
  };
  if (filePath) params.file = filePath;

  if (target.kind === "chat_id") {
    params.chat_id = target.chatId;
  } else if (target.kind === "chat_guid") {
    params.chat_guid = target.chatGuid;
  } else if (target.kind === "chat_identifier") {
    params.chat_identifier = target.chatIdentifier;
  } else {
    params.to = target.to;
  }

  const client = opts.client ?? (await createIMessageRpcClient({ cliPath, dbPath }));
  const shouldClose = !opts.client;
  try {
    const result = await client.request<Record<string, unknown>>("send", params, {
      timeoutMs: opts.timeoutMs,
    });
    const resolvedId = resolveMessageId(result);
    return {
      messageId: resolvedId ?? (result?.ok ? "ok" : "unknown"),
    };
  } finally {
    if (shouldClose) {
      await client.stop();
    }
  }
}
