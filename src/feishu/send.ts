/**
 * Feishu message sending utilities
 */

import type { MoltbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveFeishuAccount } from "./accounts.js";
import {
  createFeishuClient,
  type FeishuSendMessageResult,
  type FeishuPostContent,
  type FeishuPostElement,
} from "./client.js";

/**
 * Feishu Interactive Card structure for rich markdown messages
 *
 * Feishu supports full markdown in interactive cards (msg_type: "interactive"):
 * - Basic: **bold**, *italic*, ~~strikethrough~~, [link](url)
 * - Headings: # H1, ## H2 (only H1/H2 supported)
 * - Lists: - item (unordered), 1. item (ordered)
 * - Code: ```lang code``` (requires Feishu 7.6+)
 * - Images: ![alt](url) or img_key
 * - Horizontal rule: ---
 * - Colors: <font color='red'>text</font>
 * - @mention: <at id='all'></at>, <at id='{user_id}'></at>
 *
 * See: https://www.feishu.cn/content/7gprunv5
 */
export type FeishuInteractiveCard = {
  config?: {
    wide_screen_mode?: boolean;
    enable_forward?: boolean;
  };
  header?: {
    title?: {
      tag: "plain_text" | "lark_md";
      content: string;
    };
    template?: string; // Color: blue, wathet, turquoise, green, yellow, orange, red, carmine, violet, purple, indigo, grey
  };
  elements: Array<{
    tag: "markdown" | "div" | "hr" | "note" | "action";
    content?: string;
    text?: { tag: "plain_text" | "lark_md"; content: string };
    elements?: Array<{ tag: string; content?: string }>;
    actions?: Array<unknown>;
  }>;
};

/**
 * Build a Feishu interactive card with markdown content
 *
 * @param markdown - Markdown content to display
 * @param options - Optional card configuration
 */
export function buildFeishuMarkdownCard(
  markdown: string,
  options?: {
    title?: string;
    headerColor?: string;
    wideScreen?: boolean;
  },
): FeishuInteractiveCard {
  const card: FeishuInteractiveCard = {
    config: {
      wide_screen_mode: options?.wideScreen ?? true,
    },
    elements: [
      {
        tag: "markdown",
        content: markdown,
      },
    ],
  };

  // Add header if title provided
  if (options?.title) {
    card.header = {
      title: {
        tag: "plain_text",
        content: options.title,
      },
    };
    if (options.headerColor) {
      card.header.template = options.headerColor;
    }
  }

  return card;
}

/**
 * Convert markdown text to Feishu text format (for simple text messages)
 *
 * For simple text messages (msg_type: "text"), Feishu supports limited inline styles:
 * - Bold: **text**
 * - Italic: *text*
 * - Strikethrough: ~~text~~
 * - Link: [text](url)
 * - Colored text: <font color='green'>text</font> (green, red, grey)
 * - Mention: <at id=open_id></at> or <at user_id="all"></at>
 *
 * Note: For full markdown support (headings, lists, code blocks, images),
 * use buildFeishuMarkdownCard() with msg_type: "interactive" instead.
 */
export function markdownToFeishuText(markdown: string): string {
  let result = markdown;

  // Convert code blocks to grey colored text (```code```)
  // Note: Full code block rendering requires interactive cards
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.slice(3, -3).trim();
    return `<font color='grey'>${code}</font>`;
  });

  // Convert inline code to grey colored text (`code`)
  result = result.replace(/`([^`]+)`/g, "<font color='grey'>$1</font>");

  // Bold (**text**), italic (*text*), strikethrough (~~text~~), and links [text](url)
  // are already supported natively by Feishu text format - no conversion needed

  return result;
}

/**
 * Convert markdown text to Feishu post format (rich text)
 * Supports: bold, italic, code, links, and line breaks
 *
 * Note: For simple formatting, prefer markdownToFeishuText() with msg_type: "text"
 * as it's simpler and supports native inline styles.
 */
export function markdownToFeishuPost(markdown: string): FeishuPostContent {
  const lines = markdown.split("\n");
  const content: FeishuPostElement[][] = [];
  let currentParagraph: FeishuPostElement[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      // Empty line - end current paragraph
      if (currentParagraph.length > 0) {
        content.push(currentParagraph);
        currentParagraph = [];
      }
      continue;
    }

    // Parse inline markdown elements in the line
    const elements = parseMarkdownLine(line);
    currentParagraph.push(...elements);

    // Each line becomes a paragraph in Feishu post
    if (currentParagraph.length > 0) {
      content.push(currentParagraph);
      currentParagraph = [];
    }
  }

  // Don't forget the last paragraph
  if (currentParagraph.length > 0) {
    content.push(currentParagraph);
  }

  return {
    zh_cn: {
      content,
    },
  };
}

/**
 * Parse a single line of markdown into Feishu post elements
 */
function parseMarkdownLine(line: string): FeishuPostElement[] {
  const elements: FeishuPostElement[] = [];

  // Track position while parsing
  let lastIndex = 0;

  // Combined regex for all patterns
  const combinedRegex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((.+?)\))/g;
  let match;

  while ((match = combinedRegex.exec(line)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      const textBefore = line.slice(lastIndex, match.index);
      if (textBefore) {
        elements.push({ tag: "text", text: textBefore });
      }
    }

    const fullMatch = match[0];

    if (fullMatch.startsWith("**")) {
      // Bold: **text**
      const boldText = fullMatch.slice(2, -2);
      // Feishu doesn't have native bold in post, use text with prefix
      elements.push({ tag: "text", text: boldText });
    } else if (fullMatch.startsWith("`")) {
      // Code: `code`
      const codeText = fullMatch.slice(1, -1);
      // Feishu doesn't have inline code in post, wrap in brackets
      elements.push({ tag: "text", text: `「${codeText}」` });
    } else if (fullMatch.startsWith("[")) {
      // Link: [text](url)
      const linkMatch = /\[(.+?)\]\((.+?)\)/.exec(fullMatch);
      if (linkMatch) {
        elements.push({ tag: "a", text: linkMatch[1], href: linkMatch[2] });
      }
    } else if (fullMatch.startsWith("*")) {
      // Italic: *text*
      const italicText = fullMatch.slice(1, -1);
      // Feishu doesn't have native italic, use text
      elements.push({ tag: "text", text: italicText });
    }

    lastIndex = match.index + fullMatch.length;
  }

  // Add remaining text after last match
  if (lastIndex < line.length) {
    const textAfter = line.slice(lastIndex);
    if (textAfter) {
      elements.push({ tag: "text", text: textAfter });
    }
  }

  // If no elements were added (no markdown found), add the whole line as text
  if (elements.length === 0) {
    elements.push({ tag: "text", text: line });
  }

  return elements;
}

/**
 * Check if text contains markdown that would benefit from rich text rendering.
 * When true, sendMessageFeishu uses interactive card for full markdown support.
 */
export function hasMarkdown(text: string): boolean {
  return (
    /\*\*.+?\*\*/.test(text) || // bold
    /\*.+?\*/.test(text) || // italic
    /~~.+?~~/.test(text) || // strikethrough
    /`.+?`/.test(text) || // inline code
    /\[.+?\]\(.+?\)/.test(text) || // links
    /^#{1,6}\s+/m.test(text) || // headings (# to ######)
    /^[-*]\s+/m.test(text) || // unordered list
    /^\d+\.\s+/m.test(text) || // ordered list
    /```[\s\S]*?```/.test(text) // fenced code blocks
  );
}

export type SendFeishuMessageParams = {
  to: string;
  text: string;
  accountId?: string | null;
  config?: MoltbotConfig;
  runtime?: RuntimeEnv;
  /** Receive ID type: chat_id (default), open_id, user_id, union_id, email */
  receiveIdType?: "chat_id" | "open_id" | "user_id" | "union_id" | "email";
  /** Message type: text (default), post, or interactive */
  msgType?: "text" | "post" | "interactive";
  /** For post messages, the post content */
  postContent?: FeishuPostContent;
  /** For interactive messages, the card content */
  cardContent?: FeishuInteractiveCard;
  /** Reply to a specific message */
  replyToMessageId?: string;
  /**
   * Auto-convert markdown to rich format (default: false)
   * When enabled, uses interactive card for full markdown support:
   * - Headings: # H1, ## H2
   * - Lists: - item, 1. item
   * - Code blocks: ```lang code```
   * - Images: ![alt](url)
   * - Bold/italic/strikethrough/links
   */
  autoRichText?: boolean;
};

export type SendFeishuMessageResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};

/**
 * Send a message via Feishu
 */
export async function sendMessageFeishu(
  params: SendFeishuMessageParams,
): Promise<SendFeishuMessageResult> {
  const cfg = params.config ?? loadConfig();
  const account = resolveFeishuAccount({
    cfg,
    accountId: params.accountId,
  });

  if (account.credentials.source === "none") {
    return {
      success: false,
      error: `Feishu credentials missing for account "${account.accountId}" (set channels.feishu.appId/appSecret or FEISHU_APP_ID/FEISHU_APP_SECRET env vars).`,
    };
  }

  if (!account.enabled) {
    return {
      success: false,
      error: `Feishu account "${account.accountId}" is disabled.`,
    };
  }

  const client = createFeishuClient(account.credentials, {
    timeoutMs: (account.config.timeoutSeconds ?? 30) * 1000,
  });

  try {
    let result: FeishuSendMessageResult;

    // Determine if we should use interactive card for rich markdown
    // Interactive cards support full markdown: headings, lists, code blocks, images, etc.
    const useInteractiveCard = params.autoRichText && hasMarkdown(params.text);

    if (params.replyToMessageId) {
      // Reply to a specific message
      let content: string;
      let msgType: "text" | "post" | "interactive" = params.msgType ?? "text";

      if (params.msgType === "interactive" && params.cardContent) {
        content = JSON.stringify(params.cardContent);
        msgType = "interactive";
      } else if (params.msgType === "post" && params.postContent) {
        content = JSON.stringify({ post: params.postContent });
        msgType = "post";
      } else if (useInteractiveCard) {
        // Auto-convert to interactive card for full markdown support
        const card = buildFeishuMarkdownCard(params.text);
        content = JSON.stringify(card);
        msgType = "interactive";
      } else {
        content = JSON.stringify({ text: params.text });
        msgType = "text";
      }

      result = await client.replyMessage(params.replyToMessageId, msgType, content);
    } else if (params.msgType === "interactive" && params.cardContent) {
      // Send an explicit interactive card message
      result = await client.sendInteractiveMessage(
        params.to,
        params.cardContent,
        params.receiveIdType ?? "chat_id",
      );
    } else if (params.msgType === "post" && params.postContent) {
      // Send a post (rich text) message - explicit post format requested
      result = await client.sendPostMessage(
        params.to,
        params.postContent,
        params.receiveIdType ?? "chat_id",
      );
    } else if (useInteractiveCard) {
      // Auto-convert markdown to interactive card for full formatting support
      // Supports: # headings, - lists, ```code```, ![images], **bold**, *italic*, etc.
      const card = buildFeishuMarkdownCard(params.text);
      result = await client.sendInteractiveMessage(
        params.to,
        card,
        params.receiveIdType ?? "chat_id",
      );
    } else {
      // Send a plain text message
      result = await client.sendTextMessage(
        params.to,
        params.text,
        params.receiveIdType ?? "chat_id",
      );
    }

    return {
      success: true,
      messageId: result.message_id,
    };
  } catch (err) {
    const errorMsg = formatErrorMessage(err);
    params.runtime?.error?.(`feishu: send failed: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Send an image message via Feishu
 * Handles both upload and send in one call
 */
export async function sendImageFeishu(params: {
  to: string;
  image: Buffer | Uint8Array;
  accountId?: string | null;
  config?: MoltbotConfig;
  runtime?: RuntimeEnv;
  receiveIdType?: "chat_id" | "open_id" | "user_id" | "union_id" | "email";
}): Promise<SendFeishuMessageResult> {
  const cfg = params.config ?? loadConfig();
  const account = resolveFeishuAccount({
    cfg,
    accountId: params.accountId,
  });

  if (account.credentials.source === "none") {
    return {
      success: false,
      error: `Feishu credentials missing for account "${account.accountId}".`,
    };
  }

  if (!account.enabled) {
    return {
      success: false,
      error: `Feishu account "${account.accountId}" is disabled.`,
    };
  }

  const client = createFeishuClient(account.credentials, {
    timeoutMs: (account.config.timeoutSeconds ?? 30) * 1000,
  });

  try {
    const result = await client.uploadAndSendImage(
      params.to,
      params.image,
      params.receiveIdType ?? "chat_id",
    );

    return {
      success: true,
      messageId: result.message_id,
    };
  } catch (err) {
    const errorMsg = formatErrorMessage(err);
    params.runtime?.error?.(`feishu: send image failed: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * React to a message (Feishu supports reactions via emoji)
 * Note: This requires additional API permissions
 */
export async function reactMessageFeishu(params: {
  messageId: string;
  emoji: string;
  accountId?: string | null;
  config?: MoltbotConfig;
  runtime?: RuntimeEnv;
}): Promise<{ success: boolean; error?: string }> {
  const cfg = params.config ?? loadConfig();
  const account = resolveFeishuAccount({
    cfg,
    accountId: params.accountId,
  });

  if (account.credentials.source === "none") {
    return {
      success: false,
      error: `Feishu credentials missing for account "${account.accountId}".`,
    };
  }

  const client = createFeishuClient(account.credentials);

  try {
    // Feishu reaction API endpoint
    await client.request("POST", `/im/v1/messages/${params.messageId}/reactions`, {
      body: {
        reaction_type: {
          emoji_type: params.emoji,
        },
      },
    });

    return { success: true };
  } catch (err) {
    const errorMsg = formatErrorMessage(err);
    params.runtime?.error?.(`feishu: react failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * Delete a message
 */
export async function deleteMessageFeishu(params: {
  messageId: string;
  accountId?: string | null;
  config?: MoltbotConfig;
  runtime?: RuntimeEnv;
}): Promise<{ success: boolean; error?: string }> {
  const cfg = params.config ?? loadConfig();
  const account = resolveFeishuAccount({
    cfg,
    accountId: params.accountId,
  });

  if (account.credentials.source === "none") {
    return {
      success: false,
      error: `Feishu credentials missing for account "${account.accountId}".`,
    };
  }

  const client = createFeishuClient(account.credentials);

  try {
    await client.deleteMessage(params.messageId);
    return { success: true };
  } catch (err) {
    const errorMsg = formatErrorMessage(err);
    params.runtime?.error?.(`feishu: delete failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * Edit/update a message
 */
export async function editMessageFeishu(params: {
  messageId: string;
  text: string;
  accountId?: string | null;
  config?: MoltbotConfig;
  runtime?: RuntimeEnv;
  msgType?: "text" | "post";
  postContent?: FeishuPostContent;
}): Promise<{ success: boolean; error?: string }> {
  const cfg = params.config ?? loadConfig();
  const account = resolveFeishuAccount({
    cfg,
    accountId: params.accountId,
  });

  if (account.credentials.source === "none") {
    return {
      success: false,
      error: `Feishu credentials missing for account "${account.accountId}".`,
    };
  }

  const client = createFeishuClient(account.credentials);

  try {
    const content =
      params.msgType === "post" && params.postContent
        ? JSON.stringify({ post: params.postContent })
        : JSON.stringify({ text: params.text });

    await client.updateMessage(params.messageId, params.msgType ?? "text", content);
    return { success: true };
  } catch (err) {
    const errorMsg = formatErrorMessage(err);
    params.runtime?.error?.(`feishu: edit failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}
