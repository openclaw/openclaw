import type { MarkdownIt } from "markdown-it";
import {
  ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE,
  markdownItAssistantTranscriptRoles,
  type AssistantTranscriptRoleImageMeta,
} from "../../../packages/markdown-core/src/assistant-transcript.js";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import { t } from "../i18n/index.ts";

function renderAssistantTranscriptRoleMarker(text: string): string {
  return `<code class="assistant-transcript-role">${escapeHtml(text)}</code>`;
}

const linkedImageIndicesByTokens = new WeakMap<readonly { type: string }[], ReadonlySet<number>>();

function linkedImageIndices(tokens: readonly { type: string }[]): ReadonlySet<number> {
  const cached = linkedImageIndicesByTokens.get(tokens);
  if (cached) {
    return cached;
  }
  const linked = new Set<number>();
  let linkDepth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const tokenType = tokens[index]?.type;
    if (tokenType === "link_open") {
      linkDepth += 1;
    } else if (tokenType === "link_close") {
      linkDepth = Math.max(0, linkDepth - 1);
    } else if (tokenType === "image" && linkDepth > 0) {
      linked.add(index);
    }
  }
  linkedImageIndicesByTokens.set(tokens, linked);
  return linked;
}

function renderAssistantTranscriptRoleImageLabel(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
): string {
  let rendered = "";
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    rendered += escapeHtml(text.slice(cursor, start));
    if (end > start) {
      rendered += renderAssistantTranscriptRoleMarker(text.slice(start, end));
    }
    cursor = end;
  }
  return rendered + escapeHtml(text.slice(cursor));
}

export function installAssistantTranscriptRoleMarkdown(md: MarkdownIt): void {
  md.use(markdownItAssistantTranscriptRoles, {
    // The task-list rule injects a trusted checkbox HTML token. It is visible
    // UI structure, not text before the list item's semantic first character.
    isStructuralHtmlInline: (token) => token.meta?.taskListPlugin === true,
  });
  md.renderer.rules[ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE] = (tokens, index) => {
    const token = tokens[index];
    return token ? renderAssistantTranscriptRoleMarker(token.content) : "";
  };
  md.renderer.rules.image = (tokens, index, _rendererOptions, env) => {
    const token = tokens[index];
    if (!token) {
      return "";
    }
    const src = String(token.attrGet("src") ?? "").trim();
    // token.content preserves raw Markdown formatting in image labels.
    const alt = token.content.trim() || "image";
    const roleMeta = (token.meta as AssistantTranscriptRoleImageMeta | undefined)
      ?.assistantTranscriptRoleImage;
    const linkedImage = linkedImageIndices(tokens).has(index);
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(src) && env?.remoteImages !== true) {
      const renderedLabel = roleMeta
        ? renderAssistantTranscriptRoleImageLabel(roleMeta.text, roleMeta.spans)
        : escapeHtml(alt);
      const url = URL.parse(src);
      if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
        return renderedLabel;
      }
      const label = `<span>${escapeHtml(t("chat.externalImage.notLoaded"))}: ${renderedLabel}</span>`;
      const action = linkedImage
        ? ""
        : ` <a href="${escapeHtml(src)}">${escapeHtml(t("chat.externalImage.open"))}</a>`;
      return `<span class="markdown-external-image">${label}${action}</span>`;
    }
    const image = `<img class="markdown-inline-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
    const interactiveImage =
      linkedImage || env?.interactiveImages !== true
        ? image
        : `<button class="markdown-inline-image-button" type="button" aria-label="${escapeHtml(t("chat.imageLightbox.open", { title: token.content.trim() ? alt : t("chat.imageLightbox.untitled") }))}">${image}</button>`;
    return roleMeta
      ? `${renderAssistantTranscriptRoleMarker(`${t("sessionsView.assistant")}:`)} ${interactiveImage}`
      : interactiveImage;
  };
}

function normalizeHtmlTextContent(value: string): string {
  // Preserve HTML parser text normalization without reparsing the escaped body.
  return value.replace(/\r\n?/g, "\n").replace(/\0/g, "");
}

export function createAssistantTranscriptPlainTextFallback(
  text: string,
  enabled: boolean,
): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "markdown-plain-text-fallback";
  if (!enabled) {
    container.textContent = normalizeHtmlTextContent(text);
    return container;
  }
  const marker = document.createElement("code");
  marker.className = "assistant-transcript-role";
  marker.textContent = normalizeHtmlTextContent(`${t("sessionsView.assistant")}:`);
  const source = document.createElement("span");
  source.className = "markdown-plain-text-source";
  source.textContent = normalizeHtmlTextContent(text);
  container.append(marker, "\n", source);
  return container;
}
