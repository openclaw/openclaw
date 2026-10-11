import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "../../../components/markdown.ts";

export type DuplicateSuffix = {
  count: number;
  label: string;
};

export type MessageTextOptions = {
  role: string;
  isStreaming: boolean;
  isForwarded?: boolean;
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
  const parts: [string, string] = opts.isStreaming
    ? toStreamingMarkdownParts(source, options, isAssistant ? messageKey : undefined)
    : [toSanitizedMarkdownHtml(source, options), ""];
  if (duplicateSuffix) {
    const terminalPart = parts[1].trim() ? 1 : 0;
    parts[terminalPart] = appendDuplicateSuffix(parts[terminalPart], duplicateSuffix);
  }
  return { messageKey, source, parts, recoverFullMessage };
}

function appendDuplicateSuffix(rendered: string, suffix: DuplicateSuffix): string {
  const template = document.createElement("template");
  template.innerHTML = rendered;
  const terminalBlock = template.content.lastElementChild;
  const target = terminalBlock ? duplicateSuffixTextOwner(terminalBlock) : null;

  const badge = document.createElement("span");
  badge.className = "chat-duplicate-count";
  badge.setAttribute("aria-label", suffix.label);
  badge.textContent = `×${suffix.count}`;
  (target ?? template.content).append(document.createTextNode("\u00a0"), badge);
  return template.innerHTML;
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
