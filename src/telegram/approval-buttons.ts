import type { ReplyPayload } from "../auto-reply/types.js";
import type { TelegramInlineButtons } from "./button-types.js";

const APPROVE_ONCE_COMMAND_RE =
  /\/approve(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+allow(?:-|[\u2010-\u2015]|\u2212|\s+)once\b/i;
const APPROVE_REPLY_WITH_ONCE_LINE_RE =
  /^\s*reply with:\s*\/approve(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+allow(?:-|[\u2010-\u2015]|\u2212|\s+)once\b/i;
const MAX_CALLBACK_DATA_BYTES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fitsCallbackData(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= MAX_CALLBACK_DATA_BYTES;
}

export function extractApprovalIdFromText(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const replyLineMatch = line.match(APPROVE_REPLY_WITH_ONCE_LINE_RE);
    if (replyLineMatch?.[1]) {
      return replyLineMatch[1];
    }
  }
  const match = text.match(APPROVE_ONCE_COMMAND_RE);
  return match?.[1];
}

export function buildTelegramExecApprovalButtons(
  approvalId: string,
): TelegramInlineButtons | undefined {
  const allowOnce = `/approve ${approvalId} allow-once`;
  if (!fitsCallbackData(allowOnce)) {
    return undefined;
  }

  const allowAlways = `/approve ${approvalId} allow-always`;
  const deny = `/approve ${approvalId} deny`;
  const primaryRow: Array<{ text: string; callback_data: string }> = [
    { text: "Allow Once", callback_data: allowOnce },
  ];
  if (fitsCallbackData(allowAlways)) {
    primaryRow.push({ text: "Allow Always", callback_data: allowAlways });
  }
  const rows: Array<Array<{ text: string; callback_data: string }>> = [primaryRow];
  if (fitsCallbackData(deny)) {
    rows.push([{ text: "Deny", callback_data: deny }]);
  }
  return rows;
}

export function injectTelegramApprovalButtons(payload: ReplyPayload): ReplyPayload {
  const text = payload.text?.trim();
  if (!text || !text.includes("/approve")) {
    return payload;
  }

  const channelData = isRecord(payload.channelData) ? payload.channelData : undefined;
  const telegramData = isRecord(channelData?.telegram) ? channelData.telegram : undefined;
  if (telegramData && "buttons" in telegramData) {
    return payload;
  }

  const approvalId = extractApprovalIdFromText(text);
  if (!approvalId) {
    return payload;
  }

  const buttons = buildTelegramExecApprovalButtons(approvalId);
  if (!buttons) {
    return payload;
  }

  const nextChannelData: Record<string, unknown> = {
    ...channelData,
    telegram: {
      ...telegramData,
      buttons,
    },
  };

  return {
    ...payload,
    channelData: nextChannelData,
  };
}
