import DOMPurify from "dompurify";
import { CONTROL_UI_ROOT_PUBLIC_ASSETS } from "../../../src/gateway/control-ui-root-assets.js";
import { stripUnsupportedCitationControlMarkers } from "../../../src/shared/text/citation-control-markers.js";
import { routeIdFromPath } from "../app-route-paths.ts";
import { resolveControlUiPaths } from "../app/browser.ts";
import { i18n, t } from "../i18n/index.ts";
import { truncateText } from "../lib/format.ts";
import { parseGitHubLinkTarget } from "./github-link-target.ts";
import { createAssistantTranscriptPlainTextFallback } from "./markdown-assistant-transcript.ts";
import { renderMarkdownCodeBlock } from "./markdown-code-blocks.ts";
import { isHostLocalMarkdownFileHref } from "./markdown-file-links.ts";
import { markdownGitHubAliasSignature } from "./markdown-github-repositories.ts";
import {
  prepareMarkdownHumanMentions,
  restoreMarkdownHumanMentions,
} from "./markdown-human-mentions.ts";
import type { MarkdownJson } from "./markdown-json.ts";
import { createMarkdownParser } from "./markdown-parser.ts";
import { stripProgressCardRawContentBlocks } from "./markdown-raw-content.ts";
import {
  MARKDOWN_PARSE_LIMIT,
  normalizeMarkdownRenderOptions,
  type MarkdownRenderEnv,
  type MarkdownRenderOptions,
} from "./markdown-render-options.ts";
import {
  repairStreamingMarkdownTail,
  splitStableStreamingMarkdown,
  streamingMarkdownState,
} from "./markdown-streaming.ts";
import { isMarkdownBlockArtText, normalizeMarkdownLineBreaks } from "./markdown-text.ts";

const allowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "button",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "input",
  "li",
  "ol",
  "openclaw-person-reference",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
  "img",
];

const allowedAttrs = [
  "checked",
  "profile-id",
  "label",
  "class",
  "disabled",
  "href",
  "open",
  "rel",
  "target",
  "tabindex",
  "title",
  "start",
  "src",
  "alt",
  "data-code",
  "data-code-encoding",
  "data-file-kind",
  "data-file-line",
  "data-file-path",
  "data-link-favicon-host",
  "data-session-key",
  "data-session-href",
  "data-table-interactions",
  "type",
  "aria-expanded",
  "aria-label",
  "aria-pressed",
  "role",
];
const sanitizeOptions = {
  ALLOWED_TAGS: allowedTags,
  ALLOWED_ATTR: allowedAttrs,
  ADD_DATA_URI_TAGS: ["img"],
};
const progressSanitizeOptions = {
  ...sanitizeOptions,
  ALLOWED_TAGS: [...allowedTags, "progress"],
  ALLOWED_ATTR: [...allowedAttrs, "value", "max"],
};

let hooksInstalled = false;
const MARKDOWN_CHAR_LIMIT = 140_000;
// Covers several message-heavy sessions during rapid switching. Only inputs
// up to 50k characters enter this 500-entry LRU, keeping memory bounded.
const MARKDOWN_CACHE_LIMIT = 500;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const DOCS_ORIGIN = "https://docs.openclaw.ai";
const DOCS_ROOT_SEGMENTS = new Set([
  "agent-runtime-architecture",
  "announcements",
  "auth-credential-semantics",
  "automation",
  "brave-search",
  "channels",
  "ci",
  "clawhub",
  "cli",
  "concepts",
  "date-time",
  "debug",
  "diagnostics",
  "gateway",
  "help",
  "index",
  "install",
  "logging",
  "maturity-scorecard",
  "network",
  "nodes",
  "openclaw-agent-runtime",
  "perplexity",
  "plan",
  "platforms",
  "plugins",
  "prose",
  "providers",
  "refactor",
  "reference",
  "security",
  "specs",
  "start",
  "tools",
  "tts",
  "vps",
  "web",
]);
const DOCS_SHORTLINK_PATHS = new Set([
  "/AGENTS.default",
  "/RELEASING",
  "/agent",
  "/agent-loop",
  "/agent-send",
  "/agent-workspace",
  "/android",
  "/anthropic",
  "/architecture",
  "/audio",
  "/auth-monitoring",
  "/azure",
  "/background-process",
  "/bash",
  "/bonjour",
  "/browser",
  "/browser-linux-troubleshooting",
  "/bun",
  "/camera",
  "/clawd",
  "/clawdhub",
  "/compaction",
  "/configuration",
  "/context",
  "/context-engine",
  "/control-ui",
  "/cron",
  "/cron-jobs",
  "/cron-vs-heartbeat",
  "/dashboard",
  "/device-models",
  "/discord",
  "/discovery",
  "/docker",
  "/doctor",
  "/duckduckgo-search",
  "/elevated",
  "/exa-search",
  "/experiments/plans/cron-add-hardening",
  "/experiments/plans/group-policy-hardening",
  "/faq",
  "/gateway-lock",
  "/gcp",
  "/gemini-search",
  "/getting-started",
  "/glm",
  "/gmail-pubsub",
  "/grammy",
  "/grok-search",
  "/group-messages",
  "/groups",
  "/health",
  "/heartbeat",
  "/hubs",
  "/images",
  "/imessage",
  "/ios",
  "/kimi-search",
  "/line",
  "/linux",
  "/location",
  "/location-command",
  "/lore",
  "/mac/bun",
  "/mac/canvas",
  "/mac/child-process",
  "/mac/dev-setup",
  "/mac/health",
  "/mac/icon",
  "/mac/logging",
  "/mac/menu-bar",
  "/mac/peekaboo",
  "/mac/permissions",
  "/mac/release",
  "/mac/remote",
  "/mac/signing",
  "/mac/skills",
  "/mac/voice-overlay",
  "/mac/voicewake",
  "/mac/webchat",
  "/mac/xpc",
  "/macos",
  "/mattermost",
  "/mcp",
  "/message",
  "/messages",
  "/minimax",
  "/mistral",
  "/model",
  "/model-failover",
  "/models",
  "/moonshot",
  "/multi-agent",
  "/nix",
  "/northflank",
  "/oauth",
  "/onboarding",
  "/openai",
  "/opencode",
  "/opencode-go",
  "/openrouter",
  "/pairing",
  "/pi",
  "/pi-dev",
  "/plugin",
  "/podman",
  "/poll",
  "/presence",
  "/provider-routing",
  "/qianfan",
  "/queue",
  "/quickstart",
  "/railway",
  "/remote",
  "/remote-gateway-readme",
  "/render",
  "/rpc",
  "/sandbox",
  "/sandboxing",
  "/session",
  "/session-tool",
  "/sessions",
  "/setup",
  "/showcase",
  "/signal",
  "/skill-workshop",
  "/skills",
  "/skills-config",
  "/slack",
  "/slash-commands",
  "/subagents",
  "/tailscale",
  "/talk",
  "/telegram",
  "/templates/AGENTS",
  "/templates/BOOT",
  "/templates/BOOTSTRAP",
  "/templates/HEARTBEAT",
  "/templates/IDENTITY",
  "/templates/SOUL",
  "/templates/TOOLS",
  "/templates/USER",
  "/test",
  "/thinking",
  "/timezone",
  "/troubleshooting",
  "/tui",
  "/typebox",
  "/updating",
  "/voicewake",
  "/web-fetch",
  "/webchat",
  "/webhook",
  "/whatsapp",
  "/windows",
  "/wizard",
  "/xiaomi",
  "/zai",
]);
const APP_RESOURCE_ROOT_SEGMENTS = new Set([
  "__openclaw",
  "__openclaw__",
  "_next",
  "api",
  "assets",
  "avatar",
  "manifest.json",
  "media",
  "res",
  "socket.io",
  "static",
  "ws",
  ...CONTROL_UI_ROOT_PUBLIC_ASSETS,
]);
const APP_RESOURCE_PATH_PREFIXES = [
  ["plugins", "diffs"],
  ["plugins", "diffs-language-pack"],
];
const markdownCache = new Map<string, string>();

function getCachedMarkdown(key: string): string | null {
  const cached = markdownCache.get(key);
  if (cached === undefined) {
    return null;
  }
  markdownCache.delete(key);
  markdownCache.set(key, cached);
  return cached;
}

function setCachedMarkdown(key: string, value: string) {
  markdownCache.set(key, value);
  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) {
    return;
  }
  const oldest = markdownCache.keys().next().value;
  if (oldest) {
    markdownCache.delete(oldest);
  }
}

function normalizeStreamingMarkdownInput(markdownLocal: string, streamKey?: string): string {
  const source = stripUnsupportedCitationControlMarkers(markdownLocal);
  const state = streamingMarkdownState(streamKey);
  const cached = state?.input;
  let normalized: string;
  if (cached && source.startsWith(cached.source)) {
    const appended = source.slice(cached.source.length);
    const normalizedAppend = normalizeMarkdownLineBreaks(appended);
    normalized =
      cached.source.endsWith("\r") && appended.startsWith("\n")
        ? `${cached.normalized.slice(0, -1)}${normalizedAppend}`
        : `${cached.normalized}${normalizedAppend}`;
  } else {
    normalized = normalizeMarkdownLineBreaks(source);
  }
  if (state) {
    state.input = source.length <= MARKDOWN_CHAR_LIMIT ? { source, normalized } : undefined;
  }
  return normalized;
}

function isControlUiRoutePath(pathname: string): boolean {
  if (routeIdFromPath(pathname) !== null) {
    return true;
  }
  const basePath = currentControlUiBasePath();
  if (!basePath) {
    return false;
  }
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
    return false;
  }
  return routeIdFromPath(pathname, basePath) !== null;
}

function currentControlUiBasePath(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return resolveControlUiPaths(window.location.pathname)[0];
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function stripCurrentControlUiBasePath(pathname: string): string[] {
  const segments = pathSegments(pathname);
  const baseSegments = pathSegments(currentControlUiBasePath());
  if (
    baseSegments.length === 0 ||
    baseSegments.some((segment, index) => segments[index] !== segment)
  ) {
    return segments;
  }
  return segments.slice(baseSegments.length);
}

function segmentsStartWith(segments: string[], prefix: string[]): boolean {
  return prefix.every((segment, index) => segments[index] === segment);
}

function isControlUiResourcePath(segments: string[]): boolean {
  if (segments.includes("__openclaw__") || segments.includes("__openclaw")) {
    return true;
  }
  const segment = segments[0];
  if (!segment || APP_RESOURCE_ROOT_SEGMENTS.has(segment)) {
    return true;
  }
  return APP_RESOURCE_PATH_PREFIXES.some((prefix) => segmentsStartWith(segments, prefix));
}

function isDocsRootPath(normalizedPath: string, segments: string[]): boolean {
  if (DOCS_SHORTLINK_PATHS.has(normalizedPath)) {
    return true;
  }
  const segment = segments[0];
  return segment ? DOCS_ROOT_SEGMENTS.has(segment) : false;
}

function normalizeDocsRootHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return href;
  }
  try {
    const url = new URL(trimmed, DOCS_ORIGIN);
    if (url.origin !== DOCS_ORIGIN) {
      return href;
    }
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (isControlUiRoutePath(normalizedPath)) {
      return href;
    }
    const segments = pathSegments(normalizedPath);
    const resourceSegments = stripCurrentControlUiBasePath(normalizedPath);
    if (isControlUiResourcePath(resourceSegments)) {
      return href;
    }
    if (isDocsRootPath(normalizedPath, segments)) {
      return url.href;
    }
    return href;
  } catch {
    return href;
  }
}

function hasMarkdownContentName(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return Boolean(node.textContent?.trim());
  }
  if (
    !(node instanceof Element) ||
    node.getAttribute("aria-hidden")?.trim().toLowerCase() === "true"
  ) {
    return false;
  }
  if (node.matches("img[alt]")) {
    return Boolean(node.getAttribute("alt")?.trim());
  }
  if (node.matches("progress")) {
    // A progress value names its containing link; fallback text does not.
    const valueText = node.getAttribute("aria-valuetext");
    if (valueText !== null) {
      return Boolean(valueText.trim());
    }
    return (
      node.hasAttribute("value") ||
      node.hasAttribute("aria-valuenow") ||
      Boolean(node.getAttribute("aria-label")?.trim() || node.getAttribute("title")?.trim())
    );
  }
  return [...node.childNodes].some(hasMarkdownContentName);
}

function installHooks() {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof HTMLAnchorElement)) {
      return;
    }
    const href = node.getAttribute("href");
    if (!href) {
      return;
    }

    if (isHostLocalMarkdownFileHref(href)) {
      node.removeAttribute("href");
      return;
    }

    const normalizedHref = normalizeDocsRootHref(href);
    if (normalizedHref !== href) {
      node.setAttribute("href", normalizedHref);
    }

    // Block dangerous URL schemes (javascript:, data:, vbscript:, etc.)
    try {
      const url = new URL(normalizedHref, document.baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
        node.removeAttribute("href");
        return;
      }
      if (parseGitHubLinkTarget(url.href)) {
        for (const element of [node, ...node.querySelectorAll("[title]")]) {
          const title = element.getAttribute("title");
          // A progress control needs a label; its value only names an enclosing link.
          const hasContentName = !element.matches("progress") && hasMarkdownContentName(element);
          if (title && !hasContentName && !element.getAttribute("aria-label")?.trim()) {
            element.setAttribute("aria-label", title);
          }
          // The rendered content owns the name; native hints must not survive preview closure.
          element.removeAttribute("title");
        }
      }
      if (url.origin === window.location.origin && isControlUiRoutePath(url.pathname)) {
        node.removeAttribute("rel");
        node.removeAttribute("target");
        return;
      }
    } catch {
      // Relative URLs are fine; malformed absolute URLs with dangerous schemes
      // will fail to parse and keep their href — but DOMPurify already strips
      // javascript: by default. This is defense-in-depth.
    }

    node.setAttribute("rel", "noreferrer noopener");
    node.setAttribute("target", "_blank");
  });
}

function appendMarkdownTruncationNotice(truncated: {
  text: string;
  truncated: boolean;
  total: number;
}): string {
  const notice = truncated.truncated
    ? `\n\n${t("chat.markdown.truncated", {
        total: String(truncated.total),
        shown: String(truncated.text.length),
      })}`
    : "";
  return `${truncated.text}${notice}`;
}

const markdownParser = createMarkdownParser();

// Uncached render core shared by the static and streaming paths. The streaming
// tail changes on every delta, so routing it through here (instead of the cached
// wrapper) keeps per-message churn out of the LRU cache.
function renderSanitizedMarkdown(renderInput: string, renderOptions: MarkdownRenderEnv): string {
  installHooks();
  const activeSanitizeOptions = renderOptions.progressBars
    ? progressSanitizeOptions
    : sanitizeOptions;
  const documentMode = renderOptions.mode === "document";
  const truncated = documentMode
    ? { text: renderInput, truncated: false, total: renderInput.length }
    : truncateText(renderInput, MARKDOWN_CHAR_LIMIT);
  const input = renderOptions.progressBars
    ? stripProgressCardRawContentBlocks(appendMarkdownTruncationNotice(truncated))
    : appendMarkdownTruncationNotice(truncated);
  if (isMarkdownBlockArtText(truncated.text)) {
    return DOMPurify.sanitize(
      renderMarkdownCodeBlock(input, "", renderOptions, { blockArt: true }),
      activeSanitizeOptions,
    );
  }
  if (!documentMode && truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    // Large plain-text replies should stay readable without inheriting the
    // capped code-block chrome, while still preserving whitespace for logs
    // and other structured text that commonly trips the parse guard.
    return DOMPurify.sanitize(toPlainTextElement(input, renderOptions), activeSanitizeOptions);
  }
  let rendered: string | HTMLDivElement;
  try {
    rendered = markdownParser.render(input, renderOptions);
  } catch (err) {
    // Fall back to escaped plain text when md.render() throws (#36213).
    console.warn("[markdown] md.render failed, falling back to plain text:", err);
    rendered = toPlainTextElement(input, renderOptions);
  }
  return DOMPurify.sanitize(rendered, activeSanitizeOptions);
}

// Bare JSON bypasses Markdown normalization, which can alter literal Unicode separators.
// Both inputs still use the same code-block renderer and sanitizer boundary.
export function toSanitizedJsonHtml(json: MarkdownJson, options: MarkdownRenderOptions): string {
  installHooks();
  return DOMPurify.sanitize(
    // HTML parsing normalizes literal CRs; character references survive both
    // sanitizer parsing and the final unsafeHTML commit without changing Raw.
    renderMarkdownCodeBlock(json.text, "json", normalizeMarkdownRenderOptions(options), {
      json,
    }).replaceAll("\r", "&#13;"),
    sanitizeOptions,
  ).replaceAll("\r", "&#13;");
}

export function toSanitizedMarkdownHtml(
  markdownLocal: string,
  options: MarkdownRenderOptions = {},
): string {
  const renderOptions = normalizeMarkdownRenderOptions(options);
  const prepared =
    renderOptions.mode === "document" || markdownLocal.length <= MARKDOWN_PARSE_LIMIT
      ? prepareMarkdownHumanMentions(
          markdownLocal,
          renderOptions.humanMentions,
          markdownParser.utils.normalizeReference,
        )
      : { source: markdownLocal, tokens: [] };
  renderOptions.humanMentionTokens = prepared.tokens;
  const renderInput = normalizeMarkdownLineBreaks(
    stripUnsupportedCitationControlMarkers(prepared.source),
  );
  if (!renderInput.trim()) {
    return "";
  }
  if (renderInput.length > MARKDOWN_CACHE_MAX_CHARS) {
    return renderSanitizedMarkdown(renderInput, renderOptions);
  }
  const cacheKey = `${markdownRenderKey(renderOptions)}\0${renderInput}`;
  const cached = getCachedMarkdown(cacheKey);
  if (cached !== null) {
    return cached;
  }
  const sanitized = renderSanitizedMarkdown(renderInput, renderOptions);
  setCachedMarkdown(cacheKey, sanitized);
  return sanitized;
}

function markdownRenderKey(options: MarkdownRenderEnv): string {
  return `${i18n.getLocale()}\0${options.assistantTranscriptRoleHeaders}\0${options.codeBlockChrome}\0${options.codeBlockInteraction}\0${options.fileLinks}\0${JSON.stringify(options.githubRepo ? [options.githubRepo.owner, options.githubRepo.repo] : null)}\0${markdownGitHubAliasSignature(options.githubRepositories, options.githubRepo)}\0${options.interactiveImages}\0${options.linkFavicons}\0${options.progressBars}\0${options.mode}\0${options.remoteImages}\0${options.sessionLinks}\0${options.tableInteractions}\0${JSON.stringify(options.humanMentionTokens ?? [])}`;
}

function toPlainTextElement(value: string, options: MarkdownRenderEnv): HTMLDivElement {
  return createAssistantTranscriptPlainTextFallback(
    restoreMarkdownHumanMentions(normalizeMarkdownLineBreaks(value), options.humanMentionTokens),
    options.assistantTranscriptRoleHeaders,
    () => t("sessionsView.assistant"),
  );
}

export function toStreamingMarkdownParts(
  markdownLocal: string,
  options: MarkdownRenderOptions = {},
  streamKey?: string,
): [stableHtml: string, tailHtml: string] {
  const renderOptions = normalizeMarkdownRenderOptions(options);
  // Explicit selections are complete user input, not incremental assistant text.
  if (renderOptions.humanMentions.length) {
    return [toSanitizedMarkdownHtml(markdownLocal, options), ""];
  }
  const rawInput = normalizeStreamingMarkdownInput(markdownLocal, streamKey);
  if (isMarkdownBlockArtText(rawInput)) {
    return ["", renderSanitizedMarkdown(rawInput, renderOptions)];
  }

  if (!rawInput.trim()) {
    return ["", ""];
  }
  const truncated = truncateText(rawInput, MARKDOWN_CHAR_LIMIT);
  const input = appendMarkdownTruncationNotice(truncated);

  const { boundary, tailRepairStart } = splitStableStreamingMarkdown(
    input,
    streamKey,
    truncated.text.length,
  );
  const stableMarkdown = input.slice(0, boundary);
  const streamingTail = input.slice(boundary);
  const state = streamingMarkdownState(streamKey);
  const previous = state?.rendered;
  const renderKey = markdownRenderKey(renderOptions);
  // Containers and block-art classification can outlive a completed boundary.
  // The message parse guard also keeps applying to the complete prefix.
  const incremental =
    previous?.options === renderKey &&
    stableMarkdown.startsWith(previous.markdown) &&
    (previous.markdown === stableMarkdown ||
      (previous.markdown.endsWith("\n") &&
        !/^(?: {4}| {0,3}[\t>])/mu.test(stableMarkdown) &&
        !/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/mu.test(stableMarkdown) &&
        !stableMarkdown.includes("<") &&
        !isMarkdownBlockArtText(stableMarkdown) &&
        !previous.html.includes('class="markdown-block-art"') &&
        (renderOptions.mode === "document" || boundary <= MARKDOWN_PARSE_LIMIT)));
  let stableHtml = incremental ? previous.html : "";
  const stableAppend = stableMarkdown.slice(incremental ? previous.markdown.length : 0);
  if (stableAppend) {
    const appendedHtml = renderSanitizedMarkdown(stableAppend, { ...renderOptions });
    // File-label collisions and standalone block art depend on the whole prefix.
    stableHtml =
      (stableHtml.length > 0 && isMarkdownBlockArtText(stableAppend)) ||
      (renderOptions.fileLinks &&
        stableHtml.includes('class="markdown-file-link"') &&
        appendedHtml.includes('class="markdown-file-link"'))
        ? renderSanitizedMarkdown(stableMarkdown, { ...renderOptions })
        : stableHtml + appendedHtml;
  }
  if (state) {
    state.rendered = { options: renderKey, markdown: stableMarkdown, html: stableHtml };
  }
  if (!streamingTail.trim()) {
    return [stableHtml, ""];
  }
  const tailHtml =
    tailRepairStart === null
      ? renderSanitizedMarkdown(streamingTail, { ...renderOptions, streamingOpenFence: true })
      : renderSanitizedMarkdown(
          repairStreamingMarkdownTail(streamingTail, tailRepairStart - boundary),
          renderOptions,
        );
  return [stableHtml, tailHtml];
}
