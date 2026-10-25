import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import {
  partitionMarkdownHtml,
  toSanitizedMarkdownHtml,
  toStreamingMarkdownDomParts,
} from "../../../components/markdown.ts";
import { markdownContentHtml, type MarkdownContent } from "../../../lib/markdown-content.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";

export type DuplicateSuffix = {
  count: number;
  label: string;
};

export type MessageTextOptions = {
  role: string;
  isStreaming: boolean;
  isForwarded?: boolean;
  fetchLinkFavicon?: LinkFaviconFetcher;
  isUserMessageExpanded?: (messageId: string) => boolean;
  onToggleUserMessageExpanded?: (messageId: string) => void;
  assistantMessageDisclosure?: AssistantMessageDisclosure;
};

export type AssistantMessageDisclosure = {
  expanded: boolean;
  markdown?: string;
  message?: unknown;
  /** Set when automatic full-message retries exhausted; invoking re-enters the loader. */
  onRetryFullMessage?: () => void;
};

export function prepareMessageMarkdown(
  markdown: string,
  messageKey: string,
  opts: MessageTextOptions,
  markdownRenderOptions: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
) {
  const disclosure = opts.assistantMessageDisclosure;
  const isAssistant = opts.role === "assistant";
  const recoverFullMessage =
    isAssistant || (opts.role === "user" && Boolean(disclosure?.onRetryFullMessage));
  const recovered = recoverFullMessage && disclosure?.expanded;
  const source = recovered ? (disclosure.markdown ?? markdown) : markdown;
  const options: MarkdownRenderOptions = recovered
    ? { ...markdownRenderOptions, mode: "document" }
    : markdownRenderOptions;
  const parts: [MarkdownContent, MarkdownContent] = opts.isStreaming
    ? toStreamingMarkdownDomParts(source, options, isAssistant ? messageKey : undefined)
    : partitionMarkdownHtml(toSanitizedMarkdownHtml(source, options), messageKey);
  if (duplicateSuffix) {
    const terminalPart = markdownContentHtml(parts[1]).trim() ? 1 : 0;
    const template = document.createElement("template");
    const content = parts[terminalPart];
    if (typeof content === "string") {
      template.innerHTML = content;
    } else {
      template.content.append(content.fragment.cloneNode(true));
    }
    const terminalBlock = template.content.lastElementChild;
    const target = terminalBlock ? duplicateSuffixTextOwner(terminalBlock) : null;

    const badge = document.createElement("span");
    badge.className = "chat-duplicate-count";
    badge.setAttribute("aria-label", duplicateSuffix.label);
    badge.textContent = `×${duplicateSuffix.count}`;
    (target ?? template.content).append(document.createTextNode("\u00a0"), badge);
    parts[terminalPart] =
      typeof content === "string"
        ? template.innerHTML
        : { html: template.innerHTML, fragment: template.content };
  }
  return { messageKey, source, parts, recoverFullMessage };
}

function duplicateSuffixTextOwner(block: Element): Element | null {
  if (/^(?:P|H[1-6])$/u.test(block.tagName)) {
    return block;
  }
  if (!/^(?:BLOCKQUOTE|LI|OL|UL)$/u.test(block.tagName)) {
    // Fences, details, raw blocks, and table shells own interactive or copied
    // content. Keep the status marker after the whole terminal block.
    return null;
  }
  const terminalChild = block.lastElementChild;
  if (!terminalChild) {
    return block.textContent?.trim() ? block : null;
  }
  return duplicateSuffixTextOwner(terminalChild);
}
