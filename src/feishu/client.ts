/**
 * Feishu (Lark) API Client
 *
 * Handles authentication and API calls to Feishu Open Platform.
 * API Base: https://open.feishu.cn/open-apis
 */

import type { FeishuCredentials } from "./token.js";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

export type FeishuApiError = {
  code: number;
  msg: string;
};

export type FeishuApiResponse<T> = {
  code: number;
  msg: string;
  data?: T;
};

type FeishuMessageResourceType = "image" | "file" | "audio" | "video";

export type FeishuTenantAccessToken = {
  tenant_access_token: string;
  expire: number;
};

export type FeishuMessageContent = {
  text?: string;
  post?: FeishuPostContent;
  image_key?: string;
  file_key?: string;
};

export type FeishuPostContent = {
  zh_cn?: {
    title?: string;
    content: FeishuPostElement[][];
  };
  en_us?: {
    title?: string;
    content: FeishuPostElement[][];
  };
};

export type FeishuPostElement =
  | { tag: "text"; text: string }
  | { tag: "a"; text: string; href: string }
  | { tag: "at"; user_id: string; user_name?: string }
  | { tag: "img"; image_key: string }
  | { tag: "media"; file_key: string };

export type FeishuSendMessageParams = {
  receive_id: string;
  receive_id_type: "chat_id" | "open_id" | "user_id" | "union_id" | "email";
  msg_type: "text" | "post" | "image" | "file" | "audio" | "media" | "sticker" | "interactive";
  content: string; // JSON stringified content
  uuid?: string; // Idempotency key
};

export type FeishuSendMessageResult = {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type: string;
  create_time: string;
  update_time: string;
  deleted: boolean;
  updated: boolean;
  chat_id: string;
  sender: {
    id: string;
    id_type: string;
    sender_type: string;
  };
  body: {
    content: string;
  };
};

export type FeishuChatInfo = {
  chat_id: string;
  name?: string;
  description?: string;
  avatar?: string;
  owner_id?: string;
  owner_id_type?: string;
  chat_mode?: string;
  chat_type?: string;
  chat_tag?: string;
  external?: boolean;
  tenant_key?: string;
};

export type FeishuUser = {
  user_id?: string;
  open_id?: string;
  union_id?: string;
  name?: string;
  en_name?: string;
  nickname?: string;
  email?: string;
  mobile?: string;
  avatar?: {
    avatar_72?: string;
    avatar_240?: string;
    avatar_640?: string;
    avatar_origin?: string;
  };
};

// Token cache for tenant access tokens
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Get tenant access token for a Feishu app
 */
export async function getTenantAccessToken(credentials: FeishuCredentials): Promise<string> {
  const cacheKey = `${credentials.appId}`;
  const cached = tokenCache.get(cacheKey);

  // Return cached token if still valid (with 60s buffer)
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const url = `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: credentials.appId,
      app_secret: credentials.appSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get tenant access token: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as FeishuApiResponse<FeishuTenantAccessToken> & {
    tenant_access_token?: string;
    expire?: number;
  };

  if (result.code !== 0) {
    throw new Error(`Feishu API error: ${result.code} ${result.msg}`);
  }

  // Handle both nested and flat response formats
  const token = result.data?.tenant_access_token ?? result.tenant_access_token;
  const expire = result.data?.expire ?? result.expire ?? 7200;

  if (!token) {
    throw new Error("No tenant_access_token in response");
  }

  // Cache the token
  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + expire * 1000,
  });

  return token;
}

/**
 * Feishu API client instance
 */
export class FeishuClient {
  private credentials: FeishuCredentials;
  private timeoutMs: number;

  constructor(credentials: FeishuCredentials, opts?: { timeoutMs?: number }) {
    this.credentials = credentials;
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  /**
   * Make an authenticated API request
   */
  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    path: string,
    opts?: {
      params?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<FeishuApiResponse<T>> {
    const token = await getTenantAccessToken(this.credentials);

    let url = `${FEISHU_API_BASE}${path}`;
    if (opts?.params && Object.keys(opts.params).length > 0) {
      const searchParams = new URLSearchParams(opts.params);
      url += `?${searchParams.toString()}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const fetchOpts: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      // Only include body for methods that support it
      if (opts?.body && method !== "GET") {
        fetchOpts.body = JSON.stringify(opts.body);
      }
      const response = await fetch(url, fetchOpts);

      if (!response.ok) {
        // Try to read error details from response body
        let errorDetail = "";
        try {
          const errorBody = (await response.json()) as { code?: number; msg?: string };
          if (errorBody.code !== undefined || errorBody.msg) {
            errorDetail = ` (code: ${errorBody.code}, msg: ${errorBody.msg})`;
          }
        } catch {
          // Ignore JSON parse errors
        }
        throw new Error(
          `Feishu API request failed: ${response.status} ${response.statusText}${errorDetail}`,
        );
      }

      return (await response.json()) as FeishuApiResponse<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Download a message resource (image/file/audio/video).
   *
   * API (Feishu Open Platform):
   * GET /im/v1/messages/:message_id/resources/:file_key?type=image|file|audio|video
   *
   * Returns the raw bytes. The caller is responsible for mime sniffing + saving.
   */
  async getMessageResource(
    messageId: string,
    fileKey: string,
    type: FeishuMessageResourceType,
  ): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
    const token = await getTenantAccessToken(this.credentials);
    const url = `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(type)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.text()).trim();
        } catch {
          // ignore
        }
        throw new Error(
          `Failed to download message resource: ${response.status} ${response.statusText}${detail ? ` (${detail})` : ""}`,
        );
      }

      const contentType = response.headers.get("content-type") ?? undefined;
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileNameMatch = /filename\*?=(?:UTF-8''|")?([^";\n]+)"?/i.exec(disposition);
      const fileName = fileNameMatch?.[1] ? decodeURIComponent(fileNameMatch[1]) : undefined;

      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, contentType, fileName };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Send a message to a chat
   */
  async sendMessage(params: FeishuSendMessageParams): Promise<FeishuSendMessageResult> {
    const result = await this.request<FeishuSendMessageResult>("POST", "/im/v1/messages", {
      params: { receive_id_type: params.receive_id_type },
      body: {
        receive_id: params.receive_id,
        msg_type: params.msg_type,
        content: params.content,
        ...(params.uuid ? { uuid: params.uuid } : {}),
      },
    });

    if (result.code !== 0) {
      throw new Error(`Failed to send message: ${result.code} ${result.msg}`);
    }

    if (!result.data) {
      throw new Error("No data in send message response");
    }

    return result.data;
  }

  /**
   * Send a text message
   */
  async sendTextMessage(
    receiveId: string,
    text: string,
    receiveIdType: FeishuSendMessageParams["receive_id_type"] = "chat_id",
  ): Promise<FeishuSendMessageResult> {
    return this.sendMessage({
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: "text",
      content: JSON.stringify({ text }),
    });
  }

  /**
   * Send a post (rich text) message
   */
  async sendPostMessage(
    receiveId: string,
    post: FeishuPostContent,
    receiveIdType: FeishuSendMessageParams["receive_id_type"] = "chat_id",
  ): Promise<FeishuSendMessageResult> {
    return this.sendMessage({
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: "post",
      content: JSON.stringify({ post }),
    });
  }

  /**
   * Send an interactive card message with full markdown support
   *
   * Interactive cards support rich markdown formatting:
   * - Basic: **bold**, *italic*, ~~strikethrough~~, [link](url)
   * - Headings: # H1, ## H2
   * - Lists: - item, 1. item
   * - Code blocks: ```lang code```
   * - Images: ![alt](url)
   * - Colors: <font color='red'>text</font>
   * - @mention: <at id='all'></at>
   *
   * @param receiveId - Target chat/user ID
   * @param card - Interactive card JSON structure
   * @param receiveIdType - ID type (chat_id, open_id, etc.)
   */
  async sendInteractiveMessage(
    receiveId: string,
    card: unknown,
    receiveIdType: FeishuSendMessageParams["receive_id_type"] = "chat_id",
  ): Promise<FeishuSendMessageResult> {
    return this.sendMessage({
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: "interactive",
      content: JSON.stringify(card),
    });
  }

  /**
   * Upload an image to Feishu
   * API: POST /im/v1/images
   * @param image - Image data as Buffer or Uint8Array
   * @param imageType - Image type: "message" (for chat) or "avatar" (for profile)
   * @returns image_key to use when sending image messages
   */
  async uploadImage(
    image: Buffer | Uint8Array,
    imageType: "message" | "avatar" = "message",
    meta?: { contentType?: string; fileName?: string },
  ): Promise<string> {
    const token = await getTenantAccessToken(this.credentials);

    // Create form data for multipart upload
    // Convert to ArrayBuffer for Blob compatibility
    const arrayBuffer = image.buffer.slice(
      image.byteOffset,
      image.byteOffset + image.byteLength,
    ) as ArrayBuffer;
    const formData = new FormData();
    formData.append("image_type", imageType);
    const blobType = meta?.contentType?.split(";")[0]?.trim() || "application/octet-stream";
    const fileName = meta?.fileName?.trim() || "image";
    formData.append("image", new Blob([arrayBuffer], { type: blobType }), fileName);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${FEISHU_API_BASE}/im/v1/images`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.text()).trim();
        } catch {
          // ignore
        }
        throw new Error(
          `Failed to upload image: ${response.status} ${response.statusText}${detail ? ` (${detail})` : ""}`,
        );
      }

      const result = (await response.json()) as FeishuApiResponse<{ image_key: string }>;

      if (result.code !== 0) {
        throw new Error(`Failed to upload image: ${result.code} ${result.msg}`);
      }

      if (!result.data?.image_key) {
        throw new Error("No image_key in upload response");
      }

      return result.data.image_key;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Upload a file to Feishu (returns file_key).
   *
   * API: POST /im/v1/files
   *
   * Note: `fileType` is a Feishu enum-like string (e.g. "stream", "pdf", "mp4", "opus").
   */
  async uploadFile(params: {
    file: Buffer | Uint8Array;
    fileName: string;
    fileType?: string;
  }): Promise<string> {
    const token = await getTenantAccessToken(this.credentials);

    const arrayBuffer = params.file.buffer.slice(
      params.file.byteOffset,
      params.file.byteOffset + params.file.byteLength,
    ) as ArrayBuffer;

    const formData = new FormData();
    formData.append("file_type", params.fileType ?? "stream");
    formData.append("file_name", params.fileName);
    formData.append("file", new Blob([arrayBuffer]), params.fileName);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${FEISHU_API_BASE}/im/v1/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.text()).trim();
        } catch {
          // ignore
        }
        throw new Error(
          `Failed to upload file: ${response.status} ${response.statusText}${detail ? ` (${detail})` : ""}`,
        );
      }

      const result = (await response.json()) as FeishuApiResponse<{ file_key: string }>;
      if (result.code !== 0) {
        throw new Error(`Failed to upload file: ${result.code} ${result.msg}`);
      }
      if (!result.data?.file_key) {
        throw new Error("No file_key in upload response");
      }
      return result.data.file_key;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async sendFileMessage(
    receiveId: string,
    fileKey: string,
    receiveIdType: FeishuSendMessageParams["receive_id_type"] = "chat_id",
  ): Promise<FeishuSendMessageResult> {
    return this.sendMessage({
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey }),
    });
  }

  async sendAudioMessage(
    receiveId: string,
    fileKey: string,
    receiveIdType: FeishuSendMessageParams["receive_id_type"] = "chat_id",
  ): Promise<FeishuSendMessageResult> {
    return this.sendMessage({
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: "audio",
      content: JSON.stringify({ file_key: fileKey }),
    });
  }

  async sendVideoMessage(
    receiveId: string,
    fileKey: string,
    receiveIdType: FeishuSendMessageParams["receive_id_type"] = "chat_id",
  ): Promise<FeishuSendMessageResult> {
    return this.sendMessage({
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: "media",
      content: JSON.stringify({ file_key: fileKey }),
    });
  }

  /**
   * Send an image message
   * @param receiveId - Target chat/user ID
   * @param imageKey - Image key from uploadImage()
   * @param receiveIdType - ID type (chat_id, open_id, etc.)
   */
  async sendImageMessage(
    receiveId: string,
    imageKey: string,
    receiveIdType: FeishuSendMessageParams["receive_id_type"] = "chat_id",
  ): Promise<FeishuSendMessageResult> {
    return this.sendMessage({
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
    });
  }

  /**
   * Upload and send an image in one call
   * @param receiveId - Target chat/user ID
   * @param image - Image data as Buffer or Uint8Array
   * @param receiveIdType - ID type (chat_id, open_id, etc.)
   */
  async uploadAndSendImage(
    receiveId: string,
    image: Buffer | Uint8Array,
    receiveIdType: FeishuSendMessageParams["receive_id_type"] = "chat_id",
    meta?: { contentType?: string; fileName?: string },
  ): Promise<FeishuSendMessageResult> {
    const imageKey = await this.uploadImage(image, "message", meta);
    return this.sendImageMessage(receiveId, imageKey, receiveIdType);
  }

  /**
   * Reply to a message
   */
  async replyMessage(
    messageId: string,
    msgType: FeishuSendMessageParams["msg_type"],
    content: string,
  ): Promise<FeishuSendMessageResult> {
    const result = await this.request<FeishuSendMessageResult>(
      "POST",
      `/im/v1/messages/${messageId}/reply`,
      {
        body: {
          msg_type: msgType,
          content,
        },
      },
    );

    if (result.code !== 0) {
      throw new Error(`Failed to reply to message: ${result.code} ${result.msg}`);
    }

    if (!result.data) {
      throw new Error("No data in reply message response");
    }

    return result.data;
  }

  /**
   * List chats the bot has joined
   */
  async listChats(opts?: {
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ items: FeishuChatInfo[]; has_more: boolean; page_token?: string }> {
    const params: Record<string, string> = {};
    if (opts?.pageSize) params.page_size = String(opts.pageSize);
    if (opts?.pageToken) params.page_token = opts.pageToken;

    const result = await this.request<{
      items: FeishuChatInfo[];
      has_more: boolean;
      page_token?: string;
    }>("GET", "/im/v1/chats", { params });

    if (result.code !== 0) {
      throw new Error(`Failed to list chats: ${result.code} ${result.msg}`);
    }

    return result.data ?? { items: [], has_more: false };
  }

  /**
   * Get chat info by chat_id
   */
  async getChatInfo(chatId: string): Promise<FeishuChatInfo> {
    const result = await this.request<FeishuChatInfo>("GET", `/im/v1/chats/${chatId}`);

    if (result.code !== 0) {
      throw new Error(`Failed to get chat info: ${result.code} ${result.msg}`);
    }

    if (!result.data) {
      throw new Error("No data in chat info response");
    }

    return result.data;
  }

  /**
   * Get chat members
   */
  async getChatMembers(
    chatId: string,
    opts?: { pageSize?: number; pageToken?: string },
  ): Promise<{ items: FeishuUser[]; has_more: boolean; page_token?: string }> {
    const params: Record<string, string> = { member_id_type: "open_id" };
    if (opts?.pageSize) params.page_size = String(opts.pageSize);
    if (opts?.pageToken) params.page_token = opts.pageToken;

    const result = await this.request<{
      items: Array<{ member_id: string; member_id_type: string; name?: string }>;
      has_more: boolean;
      page_token?: string;
    }>("GET", `/im/v1/chats/${chatId}/members`, { params });

    if (result.code !== 0) {
      throw new Error(`Failed to get chat members: ${result.code} ${result.msg}`);
    }

    const items: FeishuUser[] = (result.data?.items ?? []).map((item) => ({
      open_id: item.member_id,
      name: item.name,
    }));

    return {
      items,
      has_more: result.data?.has_more ?? false,
      page_token: result.data?.page_token,
    };
  }

  /**
   * Delete a message
   */
  async deleteMessage(messageId: string): Promise<void> {
    const result = await this.request<void>("DELETE", `/im/v1/messages/${messageId}`);

    if (result.code !== 0) {
      throw new Error(`Failed to delete message: ${result.code} ${result.msg}`);
    }
  }

  /**
   * Mark a message as read by the bot
   *
   * NOTE: Feishu's API does not support bots marking messages as read.
   * The message_read event exists for receiving notifications when users read messages,
   * but there is no corresponding API for bots to mark messages as read.
   * This method is a no-op kept for interface compatibility.
   */
  async markMessageRead(_messageId: string): Promise<void> {
    // No-op: Feishu doesn't have an API for bots to mark messages as read
    // Bots receive messages via webhooks and don't have read status like human users
  }

  /**
   * Get message read information
   * Returns users who have read a specific message
   */
  async getMessageReadUsers(
    messageId: string,
    opts?: { pageSize?: number; pageToken?: string },
  ): Promise<{
    items: Array<{
      user_id_type: string;
      user_id: string;
      timestamp: string;
    }>;
    has_more: boolean;
    page_token?: string;
  }> {
    const params: Record<string, string> = { user_id_type: "open_id" };
    if (opts?.pageSize) params.page_size = String(opts.pageSize);
    if (opts?.pageToken) params.page_token = opts.pageToken;

    const result = await this.request<{
      items: Array<{ user_id_type: string; user_id: string; timestamp: string }>;
      has_more: boolean;
      page_token?: string;
    }>("GET", `/im/v1/messages/${messageId}/read_users`, { params });

    if (result.code !== 0) {
      throw new Error(`Failed to get message read users: ${result.code} ${result.msg}`);
    }

    return result.data ?? { items: [], has_more: false };
  }

  /**
   * Update a message
   */
  async updateMessage(messageId: string, msgType: "text" | "post", content: string): Promise<void> {
    const result = await this.request<void>("PATCH", `/im/v1/messages/${messageId}`, {
      body: {
        msg_type: msgType,
        content,
      },
    });

    if (result.code !== 0) {
      throw new Error(`Failed to update message: ${result.code} ${result.msg}`);
    }
  }

  /**
   * Get bot info
   */
  async getBotInfo(): Promise<{
    app_name: string;
    open_id: string;
    activate_status?: number;
  }> {
    // The /bot/v3/info endpoint returns bot at top level, not in data
    type BotInfoResponse = {
      code: number;
      msg: string;
      bot?: {
        app_name: string;
        open_id: string;
        activate_status?: number;
        avatar_url?: string;
      };
    };

    const token = await getTenantAccessToken(this.credentials);
    const url = `${FEISHU_API_BASE}/bot/v3/info`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get bot info: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as BotInfoResponse;

    if (result.code !== 0) {
      throw new Error(`Failed to get bot info: ${result.code} ${result.msg}`);
    }

    if (!result.bot) {
      throw new Error("No bot info in response");
    }

    return result.bot;
  }
}

/**
 * Create a Feishu client from credentials
 */
export function createFeishuClient(
  credentials: FeishuCredentials,
  opts?: { timeoutMs?: number },
): FeishuClient {
  return new FeishuClient(credentials, opts);
}
