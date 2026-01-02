import { loadConfig } from "../config/config.js";
import { mediaKindFromMime } from "../media/constants.js";
import { saveMediaBuffer } from "../media/store.js";
import { loadWebMedia } from "../web/media.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import {
  formatIMessageChatTarget,
  parseIMessageTarget,
  type IMessageService,
} from "./targets.js";

export type IMessageSendOpts = {
  cliPath?: string;
  dbPath?: string;
  service?: IMessageService;
  region?: string;
  mediaUrl?: string;
  maxBytes?: number;
  timeoutMs?: number;
  chatId?: number;
  client?: IMessageRpcClient;
};

export type IMessageSendResult = {
  messageId: string;
};

function resolveCliPath(explicit?: string): string {
  const cfg = loadConfig();
  return explicit?.trim() || cfg.imessage?.cliPath?.trim() || "imsg";
}

function resolveDbPath(explicit?: string): string | undefined {
  const cfg = loadConfig();
  return explicit?.trim() || cfg.imessage?.dbPath?.trim() || undefined;
}

function resolveService(explicit?: IMessageService): IMessageService {
  const cfg = loadConfig();
  return (
    explicit ||
    (cfg.imessage?.service as IMessageService | undefined) ||
    "auto"
  );
}

function resolveRegion(explicit?: string): string {
  const cfg = loadConfig();
  return explicit?.trim() || cfg.imessage?.region?.trim() || "US";
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
  const cliPath = resolveCliPath(opts.cliPath);
  const dbPath = resolveDbPath(opts.dbPath);
  const target = parseIMessageTarget(
    opts.chatId ? formatIMessageChatTarget(opts.chatId) : to,
  );
  const service =
    opts.service ?? (target.kind === "handle" ? target.service : undefined);
  const region = resolveRegion(opts.region);
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
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
    service: resolveService(service),
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
    const result = await client.request<{ ok?: boolean }>("send", params, {
      timeoutMs: opts.timeoutMs,
    });
    return {
      messageId: result?.ok ? "ok" : "unknown",
    };
  } finally {
    if (shouldClose) {
      await client.stop();
    }
  }
}
