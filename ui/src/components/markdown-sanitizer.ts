import DOMPurify from "dompurify";
import { CONTROL_UI_ROOT_PUBLIC_ASSETS } from "../../../src/gateway/control-ui-root-assets.js";
import { routeIdFromPath } from "../app-route-paths.ts";
import { resolveControlUiPaths } from "../app/browser.ts";

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
  "h5",
  "h6",
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
  "data-code-highlight",
  "data-file-kind",
  "data-file-fragment",
  "data-markdown-heading",
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

const sanitizers = new Map<typeof sanitizeOptions, ReturnType<typeof DOMPurify>>();

const DOCS_ORIGIN = "https://docs.openclaw.ai";
// Published docs sections win over owner/name syntax in root-relative Markdown.
// Explicit absolute or mounted app URLs remain available for colliding owner names.
const DOCS_PLUGIN_SECTIONS = new Set([
  "architecture-internals",
  "codex-harness",
  "codex-harness-reference",
  "codex-harness-runtime",
  "google-meet",
  "hooks",
  "knowledge",
  "manifest",
  "reference",
  "sdk-agent-harness",
  "sdk-channel-plugins",
  "sdk-entrypoints",
  "sdk-migration",
  "sdk-overview",
  "sdk-provider-plugins",
  "sdk-runtime",
  "voice-call",
]);
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

export function isControlUiRoutePath(pathname: string): boolean {
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

function isControlUiResourcePath(segments: string[]): boolean {
  if (segments.includes("__openclaw__") || segments.includes("__openclaw")) {
    return true;
  }
  const segment = segments[0];
  if (!segment || APP_RESOURCE_ROOT_SEGMENTS.has(segment)) {
    return true;
  }
  return APP_RESOURCE_PATH_PREFIXES.some((prefix) =>
    prefix.every((prefixSegment, index) => segments[index] === prefixSegment),
  );
}

function isDocsRootPath(normalizedPath: string, segments: string[]): boolean {
  if (DOCS_SHORTLINK_PATHS.has(normalizedPath)) {
    return true;
  }
  const segment = segments[0];
  return segment ? DOCS_ROOT_SEGMENTS.has(segment) : false;
}

export function normalizeDocsRootHref(href: string): string {
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
    const segments = pathSegments(normalizedPath);
    if (segments[0] === "plugins" && DOCS_PLUGIN_SECTIONS.has(segments[1] ?? "")) {
      return url.href;
    }
    if (isControlUiRoutePath(normalizedPath)) {
      return href;
    }
    const resourceSegments = stripCurrentControlUiBasePath(normalizedPath);
    if (isControlUiResourcePath(resourceSegments)) {
      return href;
    }
    return isDocsRootPath(normalizedPath, segments) ? url.href : href;
  } catch {
    return href;
  }
}

export function markdownSanitizer(decorate: (node: Element) => void, progressBars = false) {
  const options = progressBars ? progressSanitizeOptions : sanitizeOptions;
  const cached = sanitizers.get(options);
  if (cached) {
    return cached;
  }
  // Persistent configs ignore per-call options; each allowlist owns its instance
  // so progress markup cannot widen ordinary Markdown or other sanitizer users.
  const sanitizer = DOMPurify(window);
  sanitizer.setConfig(options);

  sanitizer.addHook("afterSanitizeAttributes", decorate);
  sanitizers.set(options, sanitizer);
  return sanitizer;
}
