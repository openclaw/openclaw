/**
 * GramJS client wrapper for openclaw.
 *
 * Provides a simplified interface to GramJS TelegramClient with:
 * - Session persistence via StringSession
 * - Connection management
 * - Event handling
 * - Message sending/receiving
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, type NewMessageEvent } from "telegram/events";
import type { Api } from "telegram";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ConnectionState, GramJSMessageContext, SendMessageParams } from "./types.js";

const log = createSubsystemLogger("telegram-gramjs:client");

export type MessageHandler = (context: GramJSMessageContext) => Promise<void> | void;

export type ClientOptions = {
  apiId: number;
  apiHash: string;
  sessionString?: string;
  proxy?: string;
  connectionRetries?: number;
  timeout?: number;
};

export class GramJSClient {
  private client: TelegramClient;
  private sessionString: string;
  private messageHandlers: MessageHandler[] = [];
  private connected = false;
  private authorized = false;

  constructor(options: ClientOptions) {
    const {
      apiId,
      apiHash,
      sessionString = "",
      proxy: _proxy,
      connectionRetries = 5,
      timeout = 30,
    } = options;

    // Create StringSession
    const session = new StringSession(sessionString);
    this.sessionString = sessionString;

    // Initialize TelegramClient
    this.client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries,
      timeout: timeout * 1000,
      useWSS: false, // Use TCP (more reliable than WebSocket for servers)
      // TODO: Add proxy support if provided
    });

    log.verbose(`GramJS client initialized (apiId: ${apiId})`);
  }

  /**
   * Start the client with interactive authentication flow.
   * Use this during initial setup to authenticate with phone + SMS + 2FA.
   */
  async startWithAuth(params: {
    phoneNumber: () => Promise<string>;
    phoneCode: () => Promise<string>;
    password?: () => Promise<string>;
    onError?: (err: Error) => void;
  }): Promise<string> {
    const { phoneNumber, phoneCode, password, onError } = params;

    try {
      log.info("Starting GramJS client with authentication flow...");

      await this.client.start({
        phoneNumber,
        phoneCode,
        password,
        onError: (err) => {
          log.error("Auth error:", err);
          if (onError) onError(err as Error);
        },
      });

      this.connected = true;
      this.authorized = true;

      // Extract session string after successful auth
      this.sessionString = (this.client.session as StringSession).save() as unknown as string;

      const me = await this.client.getMe();
      log.success(
        `Authenticated as ${(me as Api.User).firstName} (@${(me as Api.User).username}) [ID: ${(me as Api.User).id}]`,
      );

      return this.sessionString;
    } catch (err) {
      log.error("Failed to authenticate:", err);
      throw err;
    }
  }

  /**
   * Connect with an existing session (non-interactive).
   * Use this for normal operation after initial setup.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      log.verbose("Client already connected");
      return;
    }

    try {
      log.info("Connecting to Telegram...");
      await this.client.connect();
      this.connected = true;

      // Check if session is still valid
      try {
        const me = await this.client.getMe();
        this.authorized = true;
        log.success(
          `Connected as ${(me as Api.User).firstName} (@${(me as Api.User).username}) [ID: ${(me as Api.User).id}]`,
        );
      } catch (err) {
        log.error("Session invalid or expired:", err);
        this.authorized = false;
        throw new Error("Session expired - please re-authenticate");
      }
    } catch (err) {
      log.error("Failed to connect:", err);
      this.connected = false;
      throw err;
    }
  }

  /**
   * Disconnect the client.
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      log.info("Disconnecting from Telegram...");
      await this.client.disconnect();
      this.connected = false;
      this.authorized = false;
      log.verbose("Disconnected");
    } catch (err) {
      log.error("Error during disconnect:", err);
      throw err;
    }
  }

  /**
   * Get current connection state.
   */
  async getConnectionState(): Promise<ConnectionState> {
    if (!this.connected || !this.authorized) {
      return {
        connected: this.connected,
        authorized: this.authorized,
      };
    }

    try {
      const me = await this.client.getMe();
      const user = me as Api.User;
      return {
        connected: true,
        authorized: true,
        phoneNumber: user.phone,
        userId: Number(user.id),
        username: user.username,
      };
    } catch {
      return {
        connected: this.connected,
        authorized: false,
      };
    }
  }

  /**
   * Register a message handler for incoming messages.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);

    // Register with GramJS event system
    this.client.addEventHandler(async (event: NewMessageEvent) => {
      const context = await this.convertMessageToContext(event);
      if (context) {
        for (const h of this.messageHandlers) {
          try {
            await h(context);
          } catch (err) {
            log.error("Message handler error:", err);
          }
        }
      }
    }, new NewMessage({}));
  }

  /**
   * Send a text message.
   */
  async sendMessage(params: SendMessageParams): Promise<Api.Message> {
    const { chatId, text, replyToId, parseMode, linkPreview = true } = params;

    if (!this.connected || !this.authorized) {
      throw new Error("Client not connected or authorized");
    }

    try {
      log.verbose(`Sending message to ${chatId}: ${text.slice(0, 50)}...`);

      const result = await this.client.sendMessage(chatId, {
        message: text,
        replyTo: replyToId,
        parseMode,
        linkPreview,
      });

      log.verbose(`Message sent successfully (id: ${result.id})`);
      return result;
    } catch (err) {
      log.error("Failed to send message:", err);
      throw err;
    }
  }

  /**
   * Get information about a chat/user.
   */
  async getEntity(entityId: number | string): Promise<Api.TypeEntity> {
    return await this.client.getEntity(entityId);
  }

  /**
   * Get the current user's info.
   */
  async getMe(): Promise<Api.User> {
    return (await this.client.getMe()) as Api.User;
  }

  /**
   * Get the current session string (for persistence).
   */
  getSessionString(): string {
    return this.sessionString;
  }

  /**
   * Convert GramJS NewMessageEvent to openclaw message context.
   */
  private async convertMessageToContext(
    event: NewMessageEvent,
  ): Promise<GramJSMessageContext | null> {
    try {
      const message = event.message;
      const chat = await event.getChat();

      // Extract basic info
      const messageId = message.id;
      const chatId = Number(message.chatId || message.peerId);
      const senderId = message.senderId ? Number(message.senderId) : undefined;
      const text = message.text || message.message;
      const date = message.date;
      const replyToId = message.replyTo?.replyToMsgId;

      // Chat type detection
      const isGroup =
        (chat.className === "Channel" && (chat as Api.Channel).megagroup) ||
        chat.className === "Chat";
      const isChannel = chat.className === "Channel" && !(chat as Api.Channel).megagroup;

      // Sender info
      let senderUsername: string | undefined;
      let senderFirstName: string | undefined;
      if (message.senderId) {
        try {
          const sender = await this.client.getEntity(message.senderId);
          if (sender.className === "User") {
            const user = sender as Api.User;
            senderUsername = user.username;
            senderFirstName = user.firstName;
          }
        } catch {
          // Ignore errors fetching sender info
        }
      }

      return {
        messageId,
        chatId,
        senderId,
        text,
        date,
        replyToId,
        isGroup,
        isChannel,
        chatTitle: (chat as { title?: string }).title,
        senderUsername,
        senderFirstName,
      };
    } catch (err) {
      log.error("Error converting message to context:", err);
      return null;
    }
  }

  /**
   * Check if the client is ready to send/receive messages.
   */
  isReady(): boolean {
    return this.connected && this.authorized;
  }

  /**
   * Get the underlying GramJS client (for advanced use cases).
   */
  getRawClient(): TelegramClient {
    return this.client;
  }
}
