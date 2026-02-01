/**
 * Type definitions for Telegram GramJS adapter.
 */

import type { TelegramGramJSAccountConfig } from "../config/types.telegram-gramjs.js";

/**
 * Resolved account configuration with all necessary fields populated.
 */
export type ResolvedGramJSAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: TelegramGramJSAccountConfig;
};

/**
 * Authentication state during interactive login flow.
 */
export type AuthState = {
  phase: "phone" | "code" | "password" | "complete" | "error";
  phoneNumber?: string;
  error?: string;
};

/**
 * Session management options.
 */
export type SessionOptions = {
  apiId: number;
  apiHash: string;
  sessionString?: string;
};

/**
 * Message context for inbound message handling.
 */
export type GramJSMessageContext = {
  messageId: number;
  chatId: number;
  senderId?: number;
  text?: string;
  date: number;
  replyToId?: number;
  isGroup: boolean;
  isChannel: boolean;
  chatTitle?: string;
  senderUsername?: string;
  senderFirstName?: string;
};

/**
 * Outbound message parameters.
 */
export type SendMessageParams = {
  chatId: number | string;
  text: string;
  replyToId?: number;
  parseMode?: "markdown" | "html";
  linkPreview?: boolean;
};

/**
 * Client connection state.
 */
export type ConnectionState = {
  connected: boolean;
  authorized: boolean;
  phoneNumber?: string;
  userId?: number;
  username?: string;
};
