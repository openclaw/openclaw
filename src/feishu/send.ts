/**
 * Feishu message sending utilities
 */

import type { OpenClawConfig } from "../config/config.js";
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
import { extensionForMime } from "../media/mime.js";

/**
 * Feishu Interactive Card structure for rich markdown messages
 *
 * Feishu supports markdown in interactive cards (msg_type: "interactive"):
 * - Basic: **bold**, *italic*, ~~strikethrough~~, [link](url)
 * - Headings: # H1, ## H2 (H3-H6 auto-converted to bold text)
 * - Lists: - item (unordered), 1. item (ordered) - no nesting
 * - Code: ```lang code``` (requires Feishu 7.6+)
 * - Images: ![alt](url) or img_key
 * - Horizontal rule: ---
 * - Colors: <font color='red'>text</font> (green, red, grey)
 * - @mention: <at id='all'></at>, <at id='{user_id}'></at>
 * - Tables: <table columns={[...]} data={[...]}/> (NOT standard markdown |col|col|)
 *
 * Note: Standard markdown tables (|col|col|) are auto-converted to Feishu format.
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
 * Convert H3-H6 headings to bold text (Feishu only supports H1/H2)
 *
 * Input:  ### Title
 * Output: **Title**
 *
 * Input:  #### Subtitle
 * Output: **Subtitle**
 */
function convertUnsupportedHeadings(markdown: string): string {
  // Match H3-H6 headings (### to ######) at start of line
  // Convert to bold text since Feishu doesn't support these levels
  return markdown.replace(/^(#{3,6})\s+(.+)$/gm, (_match, _hashes, title: string) => {
    return `**${title.trim()}**`;
  });
}

/**
 * Convert standard markdown table to plain text format for Feishu
 *
 * Feishu markdown in interactive cards does NOT support <table> components.
 * Convert tables to a simple text format that displays cleanly.
 *
 * Input:
 *   | Name | Age |
 *   |------|-----|
 *   | John | 30  |
 *   | Jane | 25  |
 *
 * Output:
 *   **Name** | **Age**
 *   John | 30
 *   Jane | 25
 */
function convertMarkdownTableToFeishu(markdown: string): string {
  // Match markdown table pattern
  const tableRegex = /^\|(.+)\|\s*\n\|[-|:\s]+\|\s*\n((?:\|.+\|\s*\n?)+)/gm;

  return markdown.replace(tableRegex, (_match, headerRow: string, bodyRows: string) => {
    // Parse header columns
    const headers = headerRow
      .split("|")
      .map((h: string) => h.trim())
      .filter((h: string) => h.length > 0);

    if (headers.length === 0) return _match;

    // Build header line with bold formatting
    const headerLine = headers.map((h: string) => `**${h}**`).join(" | ");

    // Parse body rows
    const dataLines = bodyRows
      .trim()
      .split("\n")
      .map((row: string) => {
        const cells = row
          .split("|")
          .map((c: string) => c.trim())
          .filter((_c: string, i: number, arr: string[]) => i > 0 && i < arr.length - 1);
        return cells.join(" | ");
      })
      .filter((line: string) => line.length > 0);

    // Return formatted table as simple text
    return [headerLine, ...dataLines].join("\n");
  });
}

/**
 * Normalize horizontal rules (---) for Feishu markdown
 *
 * Feishu requires --- to be on its own line with blank lines around it.
 * This ensures --- is properly formatted as a horizontal rule.
 *
 * Input:  text\n---\nmore
 * Output: text\n\n---\n\nmore (proper spacing for hr)
 */
function normalizeHorizontalRules(markdown: string): string {
  // Protect code blocks from modification
  const codeBlocks: string[] = [];
  let result = markdown.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    // Avoid control characters (some linters forbid them in regex literals).
    return `__OPENCLAW_FEISHU_CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // Match --- that should be horizontal rules (on their own line, possibly with whitespace)
  // Ensure blank lines before and after for Feishu to recognize as hr
  result = result.replace(/\n[ \t]*---[ \t]*\n/g, "\n\n---\n\n");
  // Handle --- at start of text
  result = result.replace(/^[ \t]*---[ \t]*\n/g, "---\n\n");
  // Handle --- at end of text
  result = result.replace(/\n[ \t]*---[ \t]*$/g, "\n\n---");

  // Restore code blocks
  result = result.replace(/__OPENCLAW_FEISHU_CODE_BLOCK_(\d+)__/g, (_match, index) => {
    return codeBlocks[parseInt(index, 10)];
  });

  return result;
}

/**
 * Build a Feishu interactive card with markdown content
 *
 * Automatically converts standard markdown features to Feishu format:
 * - Tables: |col|col| converted to <table> component
 * - Headings: # and ## native, ### to ###### converted to **bold**
 * - Horizontal rules: --- normalized with proper spacing
 * - Lists, code blocks, links, bold/italic: native support
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
  // Convert unsupported markdown features to Feishu-compatible format
  let processedMarkdown = markdown;
  processedMarkdown = convertUnsupportedHeadings(processedMarkdown); // H3-H6 → bold
  processedMarkdown = convertMarkdownTableToFeishu(processedMarkdown); // |table| → <table/>
  processedMarkdown = normalizeHorizontalRules(processedMarkdown); // --- → proper hr

  const card: FeishuInteractiveCard = {
    config: {
      wide_screen_mode: options?.wideScreen ?? true,
    },
    elements: [
      {
        tag: "markdown",
        content: processedMarkdown,
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
    /```[\s\S]*?```/.test(text) || // fenced code blocks
    /^\|.+\|$/m.test(text) || // table rows (|col|col|)
    /^\|[-|:\s]+\|$/m.test(text) || // table separator (|---|---|) - must have | delimiters
    /^-{3,}$/m.test(text) // horizontal rule (--- or more dashes)
  );
}

export type SendFeishuMessageParams = {
  to: string;
  text: string;
  accountId?: string | null;
  config?: OpenClawConfig;
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

    // Use interactive card when autoRichText is enabled
    // Interactive cards support full markdown: headings, lists, code blocks, images, etc.
    // Always use interactive card when autoRichText is true for consistent rendering
    const useInteractiveCard = params.autoRichText === true;

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
  contentType?: string;
  fileName?: string;
  accountId?: string | null;
  config?: OpenClawConfig;
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
      { contentType: params.contentType, fileName: params.fileName },
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

function resolveFeishuUploadFileName(params: {
  contentType?: string;
  fileName?: string;
  fallbackBase: string;
}): string {
  const contentType = params.contentType?.split(";")[0]?.trim() ?? undefined;
  const preferredExt = extensionForMime(contentType);

  const trimmed = params.fileName?.trim();
  if (trimmed) {
    // If we re-encoded an image (e.g., PNG → JPEG), keep filename extension in sync
    // so Feishu clients don't get confused by mismatched content-type/extension.
    if (preferredExt) {
      const lower = trimmed.toLowerCase();
      const hasAnyExt = /\.[a-z0-9]{1,6}$/i.test(lower);
      if (hasAnyExt && !lower.endsWith(preferredExt)) {
        // Replace the existing extension with the preferred one
        return trimmed.replace(/\.[a-z0-9]{1,6}$/i, preferredExt);
      }
    }
    return trimmed;
  }

  return `${params.fallbackBase}${preferredExt ?? ".bin"}`;
}

function isLikelyOpusAudio(params: { contentType?: string; fileName?: string }): boolean {
  const ct = params.contentType?.split(";")[0]?.trim().toLowerCase();
  if (ct === "audio/opus") return true;
  // OGG container with OPUS is often reported as audio/ogg
  if (ct === "audio/ogg") return true;
  const name = params.fileName?.toLowerCase() ?? "";
  return name.endsWith(".opus") || name.endsWith(".ogg");
}

/**
 * Send media (image/audio/video/file) via Feishu.
 *
 * - Images: sent as `msg_type=image` for preview; optionally also sent as `file` ("double write")
 * - Audio: sent as `audio` when OPUS/OGG, otherwise sent as file attachment
 * - Video: sent as `media` (Feishu video) when mp4-ish, otherwise file attachment
 * - Other: sent as file attachment
 */
export async function sendMediaFeishu(params: {
  to: string;
  buffer: Buffer | Uint8Array;
  contentType?: string;
  fileName?: string;
  accountId?: string | null;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  receiveIdType?: "chat_id" | "open_id" | "user_id" | "union_id" | "email";
  kind: "image" | "audio" | "video" | "file";
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
    const receiveIdType = params.receiveIdType ?? "chat_id";
    let result: FeishuSendMessageResult | null = null;

    if (params.kind === "image") {
      const uploadName = resolveFeishuUploadFileName({
        contentType: params.contentType,
        fileName: params.fileName,
        fallbackBase: "image",
      });
      // 1) Always send previewable image message
      result = await client.uploadAndSendImage(params.to, params.buffer, receiveIdType, {
        contentType: params.contentType,
        fileName: uploadName,
      });

      // 2) Optional "double write": also upload + send as a file attachment
      // This helps preserve original bytes/filename and makes downloads easier in some clients.
      if (account.config.imageDoubleSend === true) {
        const fileName = resolveFeishuUploadFileName({
          contentType: params.contentType,
          fileName: uploadName,
          fallbackBase: "image",
        });
        const fileKey = await client.uploadFile({
          file: params.buffer,
          fileName,
          fileType: "stream",
        });
        result = await client.sendFileMessage(params.to, fileKey, receiveIdType);
      }
    } else if (params.kind === "audio") {
      const fileName = resolveFeishuUploadFileName({
        contentType: params.contentType,
        fileName: params.fileName,
        fallbackBase: "audio",
      });
      const isOpus = isLikelyOpusAudio({ contentType: params.contentType, fileName });
      const fileKey = await client.uploadFile({
        file: params.buffer,
        fileName,
        fileType: isOpus ? "opus" : "stream",
      });
      result = isOpus
        ? await client.sendAudioMessage(params.to, fileKey, receiveIdType)
        : await client.sendFileMessage(params.to, fileKey, receiveIdType);
    } else if (params.kind === "video") {
      const fileName = resolveFeishuUploadFileName({
        contentType: params.contentType,
        fileName: params.fileName,
        fallbackBase: "video",
      });
      const ct = params.contentType?.split(";")[0]?.trim().toLowerCase();
      const isMp4 = ct === "video/mp4" || fileName.toLowerCase().endsWith(".mp4");
      const fileKey = await client.uploadFile({
        file: params.buffer,
        fileName,
        fileType: isMp4 ? "mp4" : "stream",
      });
      result = isMp4
        ? await client.sendVideoMessage(params.to, fileKey, receiveIdType)
        : await client.sendFileMessage(params.to, fileKey, receiveIdType);
    } else {
      // Generic file attachment
      const fileName = resolveFeishuUploadFileName({
        contentType: params.contentType,
        fileName: params.fileName,
        fallbackBase: "file",
      });
      const fileKey = await client.uploadFile({
        file: params.buffer,
        fileName,
        fileType: "stream",
      });
      result = await client.sendFileMessage(params.to, fileKey, receiveIdType);
    }

    if (!result) {
      throw new Error("Feishu media send produced no result");
    }

    return {
      success: true,
      messageId: result.message_id,
    };
  } catch (err) {
    const errorMsg = formatErrorMessage(err);
    params.runtime?.error?.(`feishu: send media failed: ${errorMsg}`);
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
  config?: OpenClawConfig;
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
  config?: OpenClawConfig;
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
  config?: OpenClawConfig;
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
