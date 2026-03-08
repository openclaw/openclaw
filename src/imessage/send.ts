import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import { kindFromMime } from "../media/mime.js";
import { resolveOutboundAttachmentFromUrl } from "../media/outbound-attachment.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import { formatIMessageChatTarget, type IMessageService, parseIMessageTarget } from "./targets.js";

export type IMessageSendOpts = {
  cliPath?: string;
  dbPath?: string;
  service?: IMessageService;
  region?: string;
  accountId?: string;
  replyToId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  chatId?: number;
  client?: IMessageRpcClient;
  config?: ReturnType<typeof loadConfig>;
  account?: ResolvedIMessageAccount;
  resolveAttachmentImpl?: (
    mediaUrl: string,
    maxBytes: number,
    options?: { localRoots?: readonly string[] },
  ) => Promise<{ path: string; contentType?: string }>;
  createClient?: (params: { cliPath: string; dbPath?: string }) => Promise<IMessageRpcClient>;
};

export type IMessageSendResult = {
  messageId: string;
};

const MAX_REPLY_TO_ID_LENGTH = 256;

function stripUnsafeReplyTagChars(value: string): string {
  let next = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127 || ch === "[" || ch === "]") {
      continue;
    }
    next += ch;
  }
  return next;
}

function sanitizeReplyToId(rawReplyToId?: string): string | undefined {
  const trimmed = rawReplyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = stripUnsafeReplyTagChars(trimmed).trim();
  if (!sanitized) {
    return undefined;
  }
  if (sanitized.length > MAX_REPLY_TO_ID_LENGTH) {
    return sanitized.slice(0, MAX_REPLY_TO_ID_LENGTH);
  }
  return sanitized;
}

function resolveMessageId(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) {
    return null;
  }
  const raw =
    (typeof result.messageId === "string" && result.messageId.trim()) ||
    (typeof result.message_id === "string" && result.message_id.trim()) ||
    (typeof result.id === "string" && result.id.trim()) ||
    (typeof result.guid === "string" && result.guid.trim()) ||
    (typeof result.message_id === "number" ? String(result.message_id) : null) ||
    (typeof result.id === "number" ? String(result.id) : null);
  return raw ? String(raw).trim() : null;
}

export async function sendMessageIMessage(
  to: string,
  text: string,
  opts: IMessageSendOpts = {},
): Promise<IMessageSendResult> {
  const cfg = opts.config ?? loadConfig();
  const account =
    opts.account ??
    resolveIMessageAccount({
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
    const resolveAttachmentFn = opts.resolveAttachmentImpl ?? resolveOutboundAttachmentFromUrl;
    const resolved = await resolveAttachmentFn(opts.mediaUrl.trim(), maxBytes, {
      localRoots: opts.mediaLocalRoots,
    });
    filePath = resolved.path;
    if (!message.trim()) {
      const kind = kindFromMime(resolved.contentType ?? undefined);
      if (kind) {
        message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
      }
    }
  }

  if (!message.trim() && !filePath) {
    throw new Error("iMessage send requires text or media");
  }
  if (message.trim()) {
    const tableMode = resolveMarkdownTableMode({
      cfg,
      channel: "imessage",
      accountId: account.accountId,
    });
    message = convertMarkdownTables(message, tableMode);
  }
  // Strip any stray inline directive tags (e.g. [[reply_to:...]], [[audio_as_voice]])
  // so protocol-level metadata never leaks into the delivered iMessage text.
  const stripped = stripInlineDirectiveTagsForDisplay(message);
  if (stripped.changed) {
    message = stripped.text.replace(/  +/g, " ").trim();
  }

  const resolvedReplyToId = sanitizeReplyToId(opts.replyToId);
  const params: Record<string, unknown> = {
    text: message,
    service: service || "auto",
    region,
  };
  if (resolvedReplyToId) {
    params.reply_to = resolvedReplyToId;
  }
  if (filePath) {
    params.file = filePath;
  }

  if (target.kind === "chat_id") {
    params.chat_id = target.chatId;
  } else if (target.kind === "chat_guid") {
    params.chat_guid = target.chatGuid;
  } else if (target.kind === "chat_identifier") {
    params.chat_identifier = target.chatIdentifier;
  } else {
    params.to = target.to;
  }

  const client =
    opts.client ??
    (opts.createClient
      ? await opts.createClient({ cliPath, dbPath })
      : await createIMessageRpcClient({ cliPath, dbPath }));
  const shouldClose = !opts.client;
  try {
    const result = await client.request<{ ok?: string }>("send", params, {
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
