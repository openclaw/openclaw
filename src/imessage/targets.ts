import { normalizeE164 } from "../utils.js";

export type IMessageService = "imessage" | "sms" | "auto";

export type IMessageTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; to: string; service: IMessageService };

export type IMessageAllowTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; handle: string };

const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"];
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];
const CHAT_IDENTIFIER_PREFIXES = [
  "chat_identifier:",
  "chatidentifier:",
  "chatident:",
];
const SERVICE_PREFIXES: Array<{ prefix: string; service: IMessageService }> = [
  { prefix: "imessage:", service: "imessage" },
  { prefix: "sms:", service: "sms" },
  { prefix: "auto:", service: "auto" },
];

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

export function normalizeIMessageHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("imessage:")) return normalizeIMessageHandle(trimmed.slice(9));
  if (lowered.startsWith("sms:")) return normalizeIMessageHandle(trimmed.slice(4));
  if (lowered.startsWith("auto:")) return normalizeIMessageHandle(trimmed.slice(5));
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const normalized = normalizeE164(trimmed);
  if (normalized) return normalized;
  return trimmed.replace(/\s+/g, "");
}

export function parseIMessageTarget(raw: string): IMessageTarget {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("iMessage target is required");
  const lower = trimmed.toLowerCase();

  for (const prefix of CHAT_ID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (!Number.isFinite(chatId)) {
        throw new Error(`Invalid chat_id: ${value}`);
      }
      return { kind: "chat_id", chatId };
    }
  }

  for (const prefix of CHAT_GUID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (!value) throw new Error("chat_guid is required");
      return { kind: "chat_guid", chatGuid: value };
    }
  }

  for (const prefix of CHAT_IDENTIFIER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (!value) throw new Error("chat_identifier is required");
      return { kind: "chat_identifier", chatIdentifier: value };
    }
  }

  if (lower.startsWith("group:")) {
    const value = stripPrefix(trimmed, "group:");
    const chatId = Number.parseInt(value, 10);
    if (Number.isFinite(chatId)) {
      return { kind: "chat_id", chatId };
    }
    if (!value) throw new Error("group target is required");
    return { kind: "chat_guid", chatGuid: value };
  }

  for (const { prefix, service } of SERVICE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const to = stripPrefix(trimmed, prefix);
      if (!to) throw new Error(`${prefix} target is required`);
      return { kind: "handle", to, service };
    }
  }

  return { kind: "handle", to: trimmed, service: "auto" };
}

export function parseIMessageAllowTarget(raw: string): IMessageAllowTarget {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "handle", handle: "" };
  const lower = trimmed.toLowerCase();

  for (const prefix of CHAT_ID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (Number.isFinite(chatId)) return { kind: "chat_id", chatId };
    }
  }

  for (const prefix of CHAT_GUID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (value) return { kind: "chat_guid", chatGuid: value };
    }
  }

  for (const prefix of CHAT_IDENTIFIER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (value) return { kind: "chat_identifier", chatIdentifier: value };
    }
  }

  if (lower.startsWith("group:")) {
    const value = stripPrefix(trimmed, "group:");
    const chatId = Number.parseInt(value, 10);
    if (Number.isFinite(chatId)) return { kind: "chat_id", chatId };
    if (value) return { kind: "chat_guid", chatGuid: value };
  }

  return { kind: "handle", handle: normalizeIMessageHandle(trimmed) };
}

export function isAllowedIMessageSender(params: {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): boolean {
  const allowFrom = params.allowFrom.map((entry) => String(entry).trim());
  if (allowFrom.length === 0) return true;
  if (allowFrom.includes("*")) return true;

  const senderNormalized = normalizeIMessageHandle(params.sender);
  const chatId = params.chatId ?? undefined;
  const chatGuid = params.chatGuid?.trim();
  const chatIdentifier = params.chatIdentifier?.trim();

  for (const entry of allowFrom) {
    if (!entry) continue;
    const parsed = parseIMessageAllowTarget(entry);
    if (parsed.kind === "chat_id" && chatId !== undefined) {
      if (parsed.chatId === chatId) return true;
    } else if (parsed.kind === "chat_guid" && chatGuid) {
      if (parsed.chatGuid === chatGuid) return true;
    } else if (parsed.kind === "chat_identifier" && chatIdentifier) {
      if (parsed.chatIdentifier === chatIdentifier) return true;
    } else if (parsed.kind === "handle" && senderNormalized) {
      if (parsed.handle === senderNormalized) return true;
    }
  }
  return false;
}

export function formatIMessageChatTarget(chatId?: number | null): string {
  if (!chatId || !Number.isFinite(chatId)) return "";
  return `chat_id:${chatId}`;
}
