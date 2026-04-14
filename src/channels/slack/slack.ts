import { WebClient } from "@slack/web-api";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { stripInlineDirectiveTagsForDelivery } from "../../utils/directive-tags.js";

/**
 * Configuration for the Slack channel.
 */
export type SlackChannelConfig = {
  /** Slack bot token */
  token: string;
  /** Enable streaming updates (true, "partial", or false/undefined) */
  streaming?: boolean | "partial";
};

/**
 * Reference to a Slack message.
 */
export type SlackMessageRef = {
  /** Message timestamp */
  ts: string;
  /** Channel ID */
  channel: string;
};

/**
 * Context for streaming message updates.
 */
export type SlackStreamingContext = {
  /** Reference to the sent message (if any) */
  messageRef?: SlackMessageRef;
  /** Whether the message contains [[reply_to_current]] tag */
  hasReplyToCurrent: boolean;
  /** Whether streaming is enabled */
  isStreaming: boolean;
  /** Whether the partial message was skipped */
  partialSkipped: boolean;
};

/** Regex to match [[reply_to_current]] tag */
const REPLY_TO_CURRENT_RE = /\[\[\s*reply_to_current\s*\]\]/i;

/**
 * Checks if the text contains the [[reply_to_current]] tag.
 */
function hasReplyToCurrentTag(text: string): boolean {
  return REPLY_TO_CURRENT_RE.test(text);
}

/**
 * Checks if streaming is enabled in the config.
 */
function isStreamingEnabled(config: SlackChannelConfig): boolean {
  return config.streaming === true || config.streaming === "partial";
}

/**
 * Slack channel implementation.
 * Handles sending messages to Slack with special handling for
 * [[reply_to_current]] tag when streaming is enabled.
 */
export class SlackChannel {
  private client: WebClient;
  private config: SlackChannelConfig;

  constructor(config: SlackChannelConfig) {
    this.config = config;
    this.client = new WebClient(config.token);
  }

  /**
   * Creates a streaming context for a new message.
   * Analyzes the payload to determine if [[reply_to_current]] is present.
   */
  createStreamingContext(payload: ReplyPayload): SlackStreamingContext {
    const text = payload.text ?? "";
    const hasReplyToCurrent = hasReplyToCurrentTag(text);
    const isStreaming = isStreamingEnabled(this.config);

    return {
      hasReplyToCurrent,
      isStreaming,
      partialSkipped: false,
    };
  }

  /**
   * Sends a partial message during streaming.
   * When streaming is enabled and [[reply_to_current]] is present,
   * skips sending the partial message to avoid duplicates in Slack DMs.
   * 
   * @returns The message reference if sent, undefined if skipped
   */
  async sendPartial(
    channelId: string,
    payload: ReplyPayload,
    context: SlackStreamingContext,
  ): Promise<SlackMessageRef | undefined> {
    // When streaming is enabled and [[reply_to_current]] is present,
    // skip sending partial messages to avoid duplicates in Slack DMs
    if (context.isStreaming && context.hasReplyToCurrent) {
      context.partialSkipped = true;
      return undefined;
    }

    const ref = await this.sendMessage(channelId, payload);
    context.messageRef = ref;
    return ref;
  }

  /**
   * Sends the final message.
   * If the partial was skipped (due to [[reply_to_current]]), sends as a new message.
   * Otherwise, updates the existing message.
   * 
   * @returns The message reference
   */
  async sendFinal(
    channelId: string,
    payload: ReplyPayload,
    context: SlackStreamingContext,
  ): Promise<SlackMessageRef | undefined> {
    // If we skipped the partial message, send the final message as new
    if (context.partialSkipped) {
      const ref = await this.sendMessage(channelId, payload);
      context.messageRef = ref;
      return ref;
    }

    // Otherwise, update the existing message
    if (context.messageRef) {
      const ref = await this.updateMessage(context.messageRef, payload);
      context.messageRef = ref;
      return ref;
    }

    // Fallback: send as new message
    const ref = await this.sendMessage(channelId, payload);
    context.messageRef = ref;
    return ref;
  }

  /**
   * Sends a message to Slack.
   * 
   * @returns The message reference if successful
   */
  async sendMessage(
    channelId: string,
    payload: ReplyPayload,
  ): Promise<SlackMessageRef | undefined> {
    const text = payload.text ?? "";
    const { text: cleanText } = stripInlineDirectiveTagsForDelivery(text);

    const result = await this.client.chat.postMessage({
      channel: channelId,
      text: cleanText,
      thread_ts: payload.replyToId,
    });

    if (result.ts) {
      return { ts: result.ts, channel: channelId };
    }
    return undefined;
  }

  /**
   * Updates an existing message in Slack.
   * 
   * @returns The message reference if successful
   */
  async updateMessage(
    ref: SlackMessageRef,
    payload: ReplyPayload,
  ): Promise<SlackMessageRef | undefined> {
    const text = payload.text ?? "";
    const { text: cleanText } = stripInlineDirectiveTagsForDelivery(text);

    const result = await this.client.chat.update({
      channel: ref.channel,
      ts: ref.ts,
      text: cleanText,
    });

    if (result.ts) {
      return { ts: result.ts, channel: ref.channel };
    }
    return undefined;
  }
}

/**
 * Factory function to create a Slack channel instance.
 */
export function createSlackChannel(config: SlackChannelConfig): SlackChannel {
  return new SlackChannel(config);
}
