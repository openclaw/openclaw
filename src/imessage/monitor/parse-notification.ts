import type { IMessagePayload } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalStringOrNumber(value: unknown): value is string | number | null | undefined {
  return (
    value === undefined || value === null || typeof value === "string" || typeof value === "number"
  );
}

function isOptionalNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || typeof value === "number";
}

function isOptionalBoolean(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === "boolean";
}

function isOptionalStringArray(value: unknown): value is string[] | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function isOptionalAttachments(value: unknown): value is IMessagePayload["attachments"] {
  if (value === undefined || value === null) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((attachment) => {
    if (!isRecord(attachment)) {
      return false;
    }
    return (
      isOptionalString(attachment.original_path) &&
      isOptionalString(attachment.mime_type) &&
      isOptionalBoolean(attachment.missing)
    );
  });
}

const CAMEL_TO_SNAKE: ReadonlyArray<[string, string]> = [
  ["isFromMe", "is_from_me"],
  ["isGroup", "is_group"],
  ["chatId", "chat_id"],
  ["chatGuid", "chat_guid"],
  ["chatName", "chat_name"],
  ["chatIdentifier", "chat_identifier"],
  ["replyToId", "reply_to_id"],
  ["replyToText", "reply_to_text"],
  ["replyToSender", "reply_to_sender"],
  ["createdAt", "created_at"],
  ["mimeType", "mime_type"],
  ["originalPath", "original_path"],
];

/**
 * Some imsg CLI versions send camelCase keys (e.g. `isFromMe`) instead of
 * the snake_case variants (`is_from_me`) that IMessagePayload declares.
 * Copy any camelCase value into the expected snake_case slot when the
 * snake_case key is absent so downstream filters see a consistent shape.
 */
function normalizeCamelCaseKeys(record: Record<string, unknown>): void {
  for (const [camel, snake] of CAMEL_TO_SNAKE) {
    if (record[camel] !== undefined && record[snake] === undefined) {
      record[snake] = record[camel];
    }
  }

  const attachments = record.attachments;
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (isRecord(att)) {
        normalizeCamelCaseKeys(att);
      }
    }
  }
}

export function parseIMessageNotification(raw: unknown): IMessagePayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  const maybeMessage = raw.message;
  if (!isRecord(maybeMessage)) {
    return null;
  }

  normalizeCamelCaseKeys(maybeMessage);
  const message: IMessagePayload = maybeMessage;
  if (
    !isOptionalNumber(message.id) ||
    !isOptionalNumber(message.chat_id) ||
    !isOptionalString(message.sender) ||
    !isOptionalBoolean(message.is_from_me) ||
    !isOptionalString(message.text) ||
    !isOptionalStringOrNumber(message.reply_to_id) ||
    !isOptionalString(message.reply_to_text) ||
    !isOptionalString(message.reply_to_sender) ||
    !isOptionalString(message.created_at) ||
    !isOptionalAttachments(message.attachments) ||
    !isOptionalString(message.chat_identifier) ||
    !isOptionalString(message.chat_guid) ||
    !isOptionalString(message.chat_name) ||
    !isOptionalStringArray(message.participants) ||
    !isOptionalBoolean(message.is_group)
  ) {
    return null;
  }

  return message;
}
