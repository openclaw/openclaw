import type { GatewayBrowserClient } from "../gateway.ts";
import type { GmailAuthStatusResult } from "./gmail-auth.ts";

export type GmailInboxItem = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  internalDate: number | null;
  unread: boolean;
};

export type GmailThreadMessage = {
  id: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  bodyText: string;
  unread: boolean;
  messageId: string;
  references: string[];
};

export type GmailThreadView = {
  id: string;
  messages: GmailThreadMessage[];
};

type GmailMessagePart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
};

type GmailMessageRecord = {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailMessagePart;
};

type GmailThreadRecord = {
  id: string;
  messages?: GmailMessageRecord[];
};

type GmailListResponse = {
  messages?: Array<{ id?: string; threadId?: string }>;
};

export type GmailInboxState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  gmailAuthStatus: GmailAuthStatusResult | null;
  gmailInboxLoading: boolean;
  gmailInboxError: string | null;
  gmailInboxItems: GmailInboxItem[];
  gmailInboxQuery: string;
  gmailInboxUnreadOnly: boolean;
  gmailSelectedThreadId: string | null;
  gmailThreadLoading: boolean;
  gmailThreadError: string | null;
  gmailSelectedThread: GmailThreadView | null;
};

export function updateGmailInboxFilters(
  state: GmailInboxState,
  patch: { query?: string; unreadOnly?: boolean },
): void {
  if (typeof patch.query === "string") {
    state.gmailInboxQuery = patch.query;
  }
  if (typeof patch.unreadOnly === "boolean") {
    state.gmailInboxUnreadOnly = patch.unreadOnly;
  }
  state.gmailInboxError = null;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  try {
    return decodeURIComponent(
      Array.from(atob(padded))
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join(""),
    );
  } catch {
    try {
      return atob(padded);
    } catch {
      return "";
    }
  }
}

function extractHeader(message: GmailMessageRecord, name: string): string {
  const headers = (
    message.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined
  )?.headers;
  const match = headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return match?.value?.trim() ?? "";
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function collectBodyTexts(part: GmailMessagePart | undefined, output: string[]) {
  if (!part) {
    return;
  }
  const data = part.body?.data;
  if (data && typeof part.mimeType === "string") {
    if (part.mimeType.startsWith("text/plain")) {
      const decoded = decodeBase64Url(data).trim();
      if (decoded) {
        output.push(decoded);
      }
    } else if (part.mimeType.startsWith("text/html")) {
      const decoded = stripHtml(decodeBase64Url(data));
      if (decoded) {
        output.push(decoded);
      }
    }
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      collectBodyTexts(child, output);
    }
  }
}

function summarizeMessage(message: GmailMessageRecord): GmailInboxItem {
  return {
    id: message.id,
    threadId: message.threadId,
    subject: extractHeader(message, "subject") || "(no subject)",
    from: extractHeader(message, "from") || "Unknown sender",
    snippet: message.snippet?.trim() || "",
    internalDate: message.internalDate ? Number(message.internalDate) || null : null,
    unread: Array.isArray(message.labelIds) && message.labelIds.includes("UNREAD"),
  };
}

function mapThreadMessage(message: GmailMessageRecord): GmailThreadMessage {
  const bodyParts: string[] = [];
  collectBodyTexts(message.payload, bodyParts);
  const references = extractHeader(message, "references")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    id: message.id,
    subject: extractHeader(message, "subject") || "(no subject)",
    from: extractHeader(message, "from") || "Unknown sender",
    to: extractHeader(message, "to"),
    date: extractHeader(message, "date"),
    snippet: message.snippet?.trim() || "",
    bodyText: bodyParts.join("\n\n").trim(),
    unread: Array.isArray(message.labelIds) && message.labelIds.includes("UNREAD"),
    messageId: extractHeader(message, "message-id"),
    references,
  };
}

export async function loadGmailInbox(state: GmailInboxState): Promise<void> {
  if (!state.client || !state.connected || state.gmailInboxLoading) {
    return;
  }
  if (!state.gmailAuthStatus?.connected) {
    state.gmailInboxItems = [];
    state.gmailSelectedThread = null;
    state.gmailSelectedThreadId = null;
    state.gmailInboxError = null;
    state.gmailThreadError = null;
    return;
  }
  state.gmailInboxLoading = true;
  state.gmailInboxError = null;
  try {
    const trimmedQuery = state.gmailInboxQuery.trim();
    const useSearch = trimmedQuery.length > 0 || state.gmailInboxUnreadOnly;
    const list = useSearch
      ? await state.client.request<GmailListResponse>("gmail.messages.search", {
          query: trimmedQuery || undefined,
          inInbox: true,
          isUnread: state.gmailInboxUnreadOnly || undefined,
          maxResults: 12,
        })
      : await state.client.request<GmailListResponse>("gmail.messages.list", {
          labelIds: ["INBOX"],
          maxResults: 12,
        });
    const ids = Array.isArray(list.messages)
      ? list.messages
          .map((message) => (typeof message?.id === "string" ? message.id : null))
          .filter((id): id is string => Boolean(id))
      : [];
    const messages = await Promise.all(
      ids.map(async (id) => {
        const result = await state.client!.request<{ message: GmailMessageRecord }>(
          "gmail.messages.get",
          { id, format: "full" },
        );
        return result.message;
      }),
    );
    state.gmailInboxItems = messages
      .map((message) => summarizeMessage(message))
      .sort((left, right) => (right.internalDate ?? 0) - (left.internalDate ?? 0));

    const nextThreadId =
      state.gmailSelectedThreadId &&
      state.gmailInboxItems.some((item) => item.threadId === state.gmailSelectedThreadId)
        ? state.gmailSelectedThreadId
        : (state.gmailInboxItems[0]?.threadId ?? null);
    state.gmailSelectedThreadId = nextThreadId;
    if (nextThreadId) {
      await selectGmailThread(state, nextThreadId);
    } else {
      state.gmailSelectedThread = null;
      state.gmailThreadError = null;
    }
  } catch (error) {
    state.gmailInboxError = error instanceof Error ? error.message : String(error);
    state.gmailInboxItems = [];
  } finally {
    state.gmailInboxLoading = false;
  }
}

export async function selectGmailThread(state: GmailInboxState, threadId: string): Promise<void> {
  if (!state.client || !state.connected || !threadId) {
    return;
  }
  state.gmailSelectedThreadId = threadId;
  state.gmailThreadLoading = true;
  state.gmailThreadError = null;
  try {
    const result = await state.client.request<{ thread: GmailThreadRecord }>("gmail.threads.get", {
      id: threadId,
      format: "full",
    });
    const messages = Array.isArray(result.thread?.messages)
      ? result.thread.messages.map((message) => mapThreadMessage(message))
      : [];
    state.gmailSelectedThread = {
      id: result.thread.id,
      messages,
    };
  } catch (error) {
    state.gmailThreadError = error instanceof Error ? error.message : String(error);
    state.gmailSelectedThread = null;
  } finally {
    state.gmailThreadLoading = false;
  }
}
