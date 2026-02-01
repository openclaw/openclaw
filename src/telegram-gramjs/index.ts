/**
 * Telegram GramJS user account adapter for openclaw.
 *
 * Provides MTProto access to Telegram as a user account (not bot).
 *
 * Features:
 * - User account authentication (phone → SMS → 2FA)
 * - StringSession persistence
 * - Cloud chat access (DMs, groups, channels)
 * - Message sending and receiving
 *
 * Future phases:
 * - Media support (Phase 2)
 * - Secret Chats E2E encryption (Phase 3)
 */

export { GramJSClient } from "./client.js";
export { AuthFlow, runAuthFlow, verifySession } from "./auth.js";
export { configAdapter } from "./config.js";
export { setupAdapter, runSetupFlow } from "./setup.js";
export { gatewayAdapter, pollMessages, sendMessage } from "./gateway.js";
export { convertToMsgContext, buildSessionKey, extractSenderInfo } from "./handlers.js";

export type {
  ResolvedGramJSAccount,
  AuthState,
  SessionOptions,
  GramJSMessageContext,
  SendMessageParams,
  ConnectionState,
} from "./types.js";

export type {
  TelegramGramJSAccountConfig,
  TelegramGramJSConfig,
  TelegramGramJSActionConfig,
  TelegramGramJSCapabilitiesConfig,
  TelegramGramJSGroupConfig,
} from "../config/types.telegram-gramjs.js";
