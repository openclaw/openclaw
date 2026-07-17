import { promises as fs } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { sendMessageTelegram } from "@openclaw/telegram/src/send.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type AnyAgentTool,
  asToolParamsRecord,
  jsonResult,
  readStringParam,
  ToolInputError,
} from "./common.js";

const PHOTO_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
const DOCUMENT_MAX_BYTES_DEFAULT = 50 * 1024 * 1024;

export type TelegramSendFileToolOptions = {
  config?: OpenClawConfig;
  currentChannelId?: string;
  agentChannel?: string;
  agentAccountId?: string;
};

type ExecuteContext = {
  args: unknown;
  options: TelegramSendFileToolOptions;
  forceDocument: boolean;
  maxBytes: number;
  toolLabel: string;
};

const FILE_SEND_SCHEMA = {
  type: "object",
  required: ["file_path"],
  properties: {
    file_path: {
      type: "string",
      description:
        "Absolute path of the file on the server. Must be under one of the configured allowed roots (e.g. /mnt/synology/..., /mnt/qnap/...). Symlinks and ../ traversal are resolved before the check.",
    },
    caption: {
      type: "string",
      maxLength: 1024,
      description:
        "Optional caption text (Telegram limit ~1024 chars; longer values may be split or sent as a follow-up message).",
    },
  },
} satisfies Record<string, unknown>;

function isPathUnderAllowedRoot(absPath: string, allowedRoots: readonly string[]): boolean {
  return allowedRoots.some((rawRoot) => {
    const trimmed = rawRoot.replace(/\/+$/, "");
    if (!trimmed) {
      return false;
    }
    if (absPath === trimmed) {
      return true;
    }
    const prefix = trimmed + sep;
    return absPath.startsWith(prefix);
  });
}

async function executeTelegramFileSend(ctx: ExecuteContext) {
  const params = asToolParamsRecord(ctx.args);
  const rawFilePath = readStringParam(params, "file_path", {
    required: true,
    label: "file_path",
  });
  const caption = readStringParam(params, "caption");

  if (ctx.options.agentChannel !== "telegram") {
    throw new ToolInputError(
      `${ctx.toolLabel}: only available in Telegram conversations (current channel: ${
        ctx.options.agentChannel ?? "unknown"
      })`,
    );
  }

  const chatId = ctx.options.currentChannelId?.trim();
  if (!chatId) {
    throw new ToolInputError(
      `${ctx.toolLabel}: no current Telegram chat id in scope (tool can only reply to the conversation that invoked it).`,
    );
  }

  const cfg = ctx.options.config;
  if (!cfg) {
    throw new ToolInputError(`${ctx.toolLabel}: runtime config unavailable`);
  }

  const sendFileCfg = cfg.tools?.telegram?.sendFile;
  if (sendFileCfg?.enabled === false) {
    throw new ToolInputError(
      `${ctx.toolLabel}: disabled via config (tools.telegram.sendFile.enabled = false)`,
    );
  }
  const allowedPaths = sendFileCfg?.allowedPaths ?? [];
  if (allowedPaths.length === 0) {
    throw new ToolInputError(
      `${ctx.toolLabel}: no allowed paths configured (set tools.telegram.sendFile.allowedPaths in openclaw.json)`,
    );
  }

  const absPath = resolve(rawFilePath);
  if (!isPathUnderAllowedRoot(absPath, allowedPaths)) {
    throw new ToolInputError(
      `${ctx.toolLabel}: path ${absPath} is not under any allowed root (allowed: ${allowedPaths.join(", ")})`,
    );
  }

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new ToolInputError(`${ctx.toolLabel}: file not found or unreadable: ${absPath}`);
  }
  if (!stat.isFile()) {
    throw new ToolInputError(`${ctx.toolLabel}: not a regular file: ${absPath}`);
  }
  if (stat.size <= 0) {
    throw new ToolInputError(`${ctx.toolLabel}: file is empty: ${absPath}`);
  }
  if (stat.size > ctx.maxBytes) {
    const mb = (stat.size / (1024 * 1024)).toFixed(2);
    const limitMb = (ctx.maxBytes / (1024 * 1024)).toFixed(0);
    throw new ToolInputError(
      `${ctx.toolLabel}: file ${absPath} is ${mb} MB, exceeds Telegram limit of ${limitMb} MB`,
    );
  }

  const result = await sendMessageTelegram(chatId, caption ?? "", {
    cfg,
    accountId: ctx.options.agentAccountId,
    mediaUrl: `file://${absPath}`,
    mediaLocalRoots: allowedPaths,
    mediaReadFile: async (p: string) => await fs.readFile(p),
    maxBytes: ctx.maxBytes,
    forceDocument: ctx.forceDocument,
  });

  return jsonResult({
    ok: true,
    message_id: result.messageId,
    chat_id: result.chatId,
    sent_path: absPath,
    file_name: basename(absPath),
    bytes: stat.size,
    delivered_as: ctx.forceDocument ? "document" : "photo",
  });
}

export function createTelegramSendPhotoTool(
  options: TelegramSendFileToolOptions,
): AnyAgentTool | null {
  if (options.config?.tools?.telegram?.sendFile?.enabled === false) {
    return null;
  }
  const maxBytes =
    options.config?.tools?.telegram?.sendFile?.photoMaxBytes ?? PHOTO_MAX_BYTES_DEFAULT;
  return {
    label: "Telegram Send Photo",
    name: "telegram_send_photo",
    description:
      "Send a photo (JPEG/PNG/HEIC/WebP) from the server's local filesystem to the CURRENT Telegram conversation. " +
      "The file_path must be absolute and under a configured allowed root (e.g. /mnt/synology/..., /mnt/qnap/...). " +
      "Photos are delivered with Telegram's image compression and preview inline. " +
      "For non-image files (PDF, ZIP, video, etc.) or to preserve original quality, use telegram_send_document instead. " +
      "Owner-only: refuses if the requester is not the chat owner.",
    parameters: FILE_SEND_SCHEMA,
    ownerOnly: true,
    execute: async (_toolCallId, args, _signal) =>
      executeTelegramFileSend({
        args,
        options,
        forceDocument: false,
        maxBytes,
        toolLabel: "telegram_send_photo",
      }),
  };
}

export function createTelegramSendDocumentTool(
  options: TelegramSendFileToolOptions,
): AnyAgentTool | null {
  if (options.config?.tools?.telegram?.sendFile?.enabled === false) {
    return null;
  }
  const maxBytes =
    options.config?.tools?.telegram?.sendFile?.documentMaxBytes ?? DOCUMENT_MAX_BYTES_DEFAULT;
  return {
    label: "Telegram Send Document",
    name: "telegram_send_document",
    description:
      "Send any file (PDF, ZIP, video, original-quality image, etc.) from the server's local filesystem to the CURRENT Telegram conversation as a downloadable Telegram document (no compression). " +
      "The file_path must be absolute and under a configured allowed root (e.g. /mnt/synology/..., /mnt/qnap/...). " +
      "Prefer telegram_send_photo for inline-previewed images. " +
      "Owner-only: refuses if the requester is not the chat owner.",
    parameters: FILE_SEND_SCHEMA,
    ownerOnly: true,
    execute: async (_toolCallId, args, _signal) =>
      executeTelegramFileSend({
        args,
        options,
        forceDocument: true,
        maxBytes,
        toolLabel: "telegram_send_document",
      }),
  };
}
