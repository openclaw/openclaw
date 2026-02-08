/**
 * LINQ Partner API v3 HTTP client.
 *
 * Docs: https://apidocs.linqapp.com
 * Base URL: https://api.linqapp.com/api/partner/v3
 */

const BASE_URL = "https://api.linqapp.com/api/partner/v3";

/** Parts as sent in requests. */
export type LinqMessagePart =
  | { type: "text"; value: string }
  | { type: "media"; url: string }
  | { type: "media"; attachment_id: string };

/** Parts as returned from the API (messages endpoint). */
export type LinqReceivedMessagePart =
  | { type: "text"; value: string; reactions?: unknown }
  | {
      type: "media";
      id: string;
      url: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
      reactions?: unknown;
    };

export type LinqMessageEffect = {
  type: "screen" | "bubble";
  name: string;
};

export type LinqReplyTo = {
  message_id: string;
  part_index?: number;
};

export type LinqMessageContent = {
  parts: LinqMessagePart[];
  effect?: LinqMessageEffect;
  reply_to?: LinqReplyTo;
  preferred_service?: "iMessage" | "RCS" | "SMS";
};

export type LinqChatHandle = {
  id: string;
  handle: string;
  service: string;
  status: "active" | "left" | "removed";
  joined_at: string;
  left_at: string | null;
  is_me: boolean;
};

export type LinqChat = {
  id: string;
  display_name: string;
  service: string;
  handles: LinqChatHandle[];
  is_archived: boolean;
  is_group: boolean;
  created_at: string;
  updated_at: string;
};

export type LinqSentMessage = {
  id: string;
  parts: LinqMessagePart[];
  sent_at: string | null;
  delivered_at: string | null;
  delivery_status: "pending" | "queued" | "sent" | "delivered" | "failed";
  is_read: boolean;
  effect?: LinqMessageEffect;
  from_handle?: string;
  reply_to?: LinqReplyTo;
};

export type LinqMessage = {
  id: string;
  chat_id: string;
  parts: LinqReceivedMessagePart[];
  from_handle: LinqChatHandle;
  is_from_me: boolean;
  is_delivered: boolean;
  is_read: boolean;
  sent_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  delivery_status: "pending" | "queued" | "sent" | "delivered" | "failed";
  effect?: LinqMessageEffect | null;
  reply_to?: LinqReplyTo | null;
  reactions?: LinqReaction[];
};

export type LinqReaction = {
  is_me: boolean;
  handle: string;
  type: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "custom";
  custom_emoji?: string;
};

export type LinqPhoneNumber = {
  id: string;
  phone_number: string;
  type: "TWILIO" | "APPLE_ID";
  country_code: string;
  capabilities: {
    sms: boolean;
    mms: boolean;
    voice: boolean;
  };
};

export type LinqAttachment = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: "pending" | "complete" | "failed";
  download_url: string;
  created_at: string;
};

export type LinqWebhookSubscription = {
  id: string;
  url: string;
  events: string[];
  signing_secret?: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type LinqCreateChatResult = {
  chat: LinqChat;
  message: LinqSentMessage;
};

export type LinqSendMessageResponse = {
  chat_id: string;
  message: LinqSentMessage;
};

export type LinqListChatsResult = {
  chats: LinqChat[];
  next_cursor?: string;
};

export type LinqListMessagesResult = {
  messages: LinqMessage[];
  next_cursor?: string;
};

export type LinqRequestUploadResult = {
  attachment_id: string;
  upload_url: string;
  download_url: string;
  method: string;
  headers: Record<string, string>;
};

export class LinqApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | undefined,
    message: string,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = "LinqApiError";
  }
}

export class LinqClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl?: string) {
    this.token = token;
    this.baseUrl = baseUrl?.replace(/\/+$/, "") ?? BASE_URL;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, value);
        }
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (!response.ok) {
      let code: number | undefined;
      let msg = text;
      let traceId: string | undefined;
      try {
        const parsed = JSON.parse(text);
        code = parsed.error?.code;
        msg = parsed.error?.message ?? text;
        traceId = parsed.trace_id;
      } catch {
        // use raw text
      }
      throw new LinqApiError(response.status, code, msg, traceId);
    }
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  // ── Phone Numbers ──

  async listPhoneNumbers(): Promise<LinqPhoneNumber[]> {
    const result = await this.request<{ phone_numbers: LinqPhoneNumber[] }>(
      "GET",
      "/phonenumbers",
    );
    return result.phone_numbers;
  }

  // ── Chats ──

  async createChat(params: {
    from: string;
    to: string[];
    message: LinqMessageContent;
  }): Promise<LinqCreateChatResult> {
    return this.request<LinqCreateChatResult>("POST", "/chats", params);
  }

  async listChats(params: {
    from: string;
    limit?: number;
    cursor?: string;
  }): Promise<LinqListChatsResult> {
    const query: Record<string, string> = { from: params.from };
    if (params.limit !== undefined) query.limit = String(params.limit);
    if (params.cursor) query.cursor = params.cursor;
    return this.request<LinqListChatsResult>("GET", "/chats", undefined, query);
  }

  async getChat(chatId: string): Promise<LinqChat> {
    return this.request<LinqChat>("GET", `/chats/${chatId}`);
  }

  async updateChat(
    chatId: string,
    params: { display_name?: string; group_chat_icon?: string },
  ): Promise<LinqChat> {
    return this.request<LinqChat>("PUT", `/chats/${chatId}`, params);
  }

  async addParticipant(chatId: string, handle: string): Promise<void> {
    return this.request<void>("POST", `/chats/${chatId}/participants`, { handle });
  }

  async removeParticipant(chatId: string, handle: string): Promise<void> {
    return this.request<void>("DELETE", `/chats/${chatId}/participants`, { handle });
  }

  async startTyping(chatId: string): Promise<void> {
    return this.request<void>("POST", `/chats/${chatId}/typing`);
  }

  async stopTyping(chatId: string): Promise<void> {
    return this.request<void>("DELETE", `/chats/${chatId}/typing`);
  }

  async markRead(chatId: string): Promise<void> {
    return this.request<void>("POST", `/chats/${chatId}/read`);
  }

  async shareContactCard(chatId: string): Promise<void> {
    return this.request<void>("POST", `/chats/${chatId}/share_contact_card`);
  }

  // ── Messages ──

  async sendMessage(
    chatId: string,
    message: LinqMessageContent,
  ): Promise<LinqSendMessageResponse> {
    return this.request<LinqSendMessageResponse>(
      "POST",
      `/chats/${chatId}/messages`,
      { message },
    );
  }

  async listMessages(
    chatId: string,
    params?: { limit?: number; cursor?: string },
  ): Promise<LinqListMessagesResult> {
    const query: Record<string, string> = {};
    if (params?.limit !== undefined) query.limit = String(params.limit);
    if (params?.cursor) query.cursor = params.cursor;
    return this.request<LinqListMessagesResult>(
      "GET",
      `/chats/${chatId}/messages`,
      undefined,
      query,
    );
  }

  async getMessage(messageId: string): Promise<LinqMessage> {
    return this.request<LinqMessage>("GET", `/messages/${messageId}`);
  }

  async deleteMessage(messageId: string, chatId: string): Promise<void> {
    return this.request<void>("DELETE", `/messages/${messageId}`, { chat_id: chatId });
  }

  async getThread(
    messageId: string,
    params?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
  ): Promise<LinqListMessagesResult> {
    const query: Record<string, string> = {};
    if (params?.limit !== undefined) query.limit = String(params.limit);
    if (params?.cursor) query.cursor = params.cursor;
    if (params?.order) query.order = params.order;
    return this.request<LinqListMessagesResult>(
      "GET",
      `/messages/${messageId}/thread`,
      undefined,
      query,
    );
  }

  async sendVoiceMemo(
    chatId: string,
    from: string,
    voiceMemoUrl: string,
  ): Promise<LinqSendMessageResponse> {
    return this.request<LinqSendMessageResponse>("POST", `/chats/${chatId}/voicememo`, {
      from,
      voice_memo_url: voiceMemoUrl,
    });
  }

  async addReaction(
    messageId: string,
    params: {
      operation: "add" | "remove";
      type: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "custom";
      custom_emoji?: string;
      part_index?: number;
    },
  ): Promise<LinqReaction> {
    return this.request<LinqReaction>("POST", `/messages/${messageId}/reactions`, params);
  }

  // ── Attachments ──

  async requestUpload(params: {
    filename: string;
    content_type: string;
    size_bytes: number;
  }): Promise<LinqRequestUploadResult> {
    return this.request<LinqRequestUploadResult>("POST", "/attachments", params);
  }

  async getAttachment(attachmentId: string): Promise<LinqAttachment> {
    return this.request<LinqAttachment>("GET", `/attachments/${attachmentId}`);
  }

  // ── Webhooks ──

  async listWebhookEvents(): Promise<string[]> {
    const result = await this.request<{ events: string[] }>("GET", "/webhook-events");
    return result.events;
  }

  async createWebhookSubscription(params: {
    url: string;
    events: string[];
  }): Promise<LinqWebhookSubscription> {
    return this.request<LinqWebhookSubscription>("POST", "/webhook-subscriptions", params);
  }

  async listWebhookSubscriptions(): Promise<LinqWebhookSubscription[]> {
    const result = await this.request<{ subscriptions: LinqWebhookSubscription[] }>(
      "GET",
      "/webhook-subscriptions",
    );
    return result.subscriptions;
  }

  async getWebhookSubscription(id: string): Promise<LinqWebhookSubscription> {
    return this.request<LinqWebhookSubscription>("GET", `/webhook-subscriptions/${id}`);
  }

  async updateWebhookSubscription(
    id: string,
    params: { url?: string; events?: string[]; status?: string },
  ): Promise<LinqWebhookSubscription> {
    return this.request<LinqWebhookSubscription>(
      "PUT",
      `/webhook-subscriptions/${id}`,
      params,
    );
  }

  async deleteWebhookSubscription(id: string): Promise<void> {
    return this.request<void>("DELETE", `/webhook-subscriptions/${id}`);
  }
}
