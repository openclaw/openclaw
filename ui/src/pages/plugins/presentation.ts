// Presentation data for the plugins catalog: bundled cover art, deterministic
// fallback gradients, category shelving, and curated connector suggestions.
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { t } from "../../i18n/index.ts";

/**
 * Cover art bundled at ui/public/plugin-art/<slug>.webp. The gateway CSP is
 * img-src 'self', so catalog artwork must ship with the Control UI bundle;
 * remote icon URLs cannot render here.
 */
const PLUGIN_ART_SLUGS: ReadonlySet<string> = new Set([
  "acpx",
  "brave",
  "copilot",
  "diagnostics-otel",
  "diagnostics-prometheus",
  "diffs",
  "diffs-language-pack",
  "dungeon-master",
  "email-inbox",
  "exa",
  "firecrawl",
  "github",
  "google-calendar",
  "google-meet",
  "gradium",
  "grafana",
  "home-assistant",
  "inworld",
  "linear",
  "llama-cpp",
  "lobster",
  "memory-lancedb",
  "memory-wiki",
  "morning-brief",
  "notion",
  "open-prose",
  "openshell",
  "parallel",
  "perplexity",
  "philips-hue",
  "pixverse",
  "portfolio-pulse",
  "searxng",
  "sentry",
  "sonos",
  "spotify",
  "tavily",
  "tokenjuice",
  "trip-scout",
  "voice-call",
  "workboard",
  "youtube",
]);

export function pluginArtPath(slug: string): string | null {
  return PLUGIN_ART_SLUGS.has(slug)
    ? inferControlUiPublicAssetPath(`plugin-art/${slug}.webp`)
    : null;
}

/**
 * Deterministic two-stop gradients for plugins without bundled art so every
 * tile keeps a distinct identity instead of an empty box.
 */
const FALLBACK_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ["#f59e0b", "#ea580c"],
  ["#38bdf8", "#1d4ed8"],
  ["#34d399", "#047857"],
  ["#a855f7", "#6b21a8"],
  ["#f472b6", "#be185d"],
  ["#22d3ee", "#0e7490"],
  ["#fbbf24", "#b45309"],
  ["#818cf8", "#4338ca"],
  ["#4ade80", "#166534"],
  ["#fb7185", "#9f1239"],
];

export function pluginFallbackGradient(id: string): readonly [string, string] {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return FALLBACK_GRADIENTS[hash % FALLBACK_GRADIENTS.length]!;
}

export function pluginMonogram(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const initials = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`;
  return initials.toLocaleUpperCase();
}

/** Shelving order for the installed inventory; unknown categories group last. */
export const PLUGIN_CATEGORY_ORDER: readonly string[] = [
  "channel",
  "provider",
  "memory",
  "context-engine",
  "tool",
  "other",
];

export function pluginCategoryLabel(category: string): string {
  switch (category) {
    case "channel":
      return t("pluginsPage.categoryChannels");
    case "provider":
      return t("pluginsPage.categoryProviders");
    case "memory":
      return t("pluginsPage.categoryMemory");
    case "context-engine":
      return t("pluginsPage.categoryContextEngine");
    case "tool":
      return t("pluginsPage.categoryTools");
    default:
      return t("pluginsPage.categoryOther");
  }
}

export type ConnectorMcpTemplate = {
  serverName: string;
  config: {
    url?: string;
    transport?: "sse" | "streamable-http";
    auth?: "oauth";
  };
  /** Post-add step the operator still owns (OAuth login or endpoint/token edit). */
  followUp: "oauth" | "endpoint";
  docsUrl: string;
};

export type ConnectorSuggestion = {
  id: string;
  name: string;
  description: string;
  action: { kind: "mcp"; mcp: ConnectorMcpTemplate } | { kind: "clawhub"; query: string };
};

/**
 * Curated connector shelf: one-click MCP servers for official hosted endpoints
 * plus ClawHub searches proven to return live packages. Descriptions are
 * catalog data (like manifest descriptions), not localized UI chrome.
 */
export const CONNECTOR_SUGGESTIONS: readonly ConnectorSuggestion[] = [
  {
    id: "github",
    name: "GitHub",
    description: "PR review queues, issue triage, and repo Q&A through the official GitHub MCP.",
    action: {
      kind: "mcp",
      mcp: {
        serverName: "github",
        config: {
          url: "https://api.githubcopilot.com/mcp/",
          transport: "streamable-http",
          auth: "oauth",
        },
        followUp: "oauth",
        docsUrl:
          "https://docs.github.com/en/copilot/customizing-copilot/using-model-context-protocol/using-the-github-mcp-server",
      },
    },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, create, and update pages and databases in your Notion workspace.",
    action: {
      kind: "mcp",
      mcp: {
        serverName: "notion",
        config: { url: "https://mcp.notion.com/mcp", transport: "streamable-http", auth: "oauth" },
        followUp: "oauth",
        docsUrl: "https://developers.notion.com/docs/mcp",
      },
    },
  },
  {
    id: "linear",
    name: "Linear",
    description: "Triage issues, update cycles, and file bugs straight from chat.",
    action: {
      kind: "mcp",
      mcp: {
        serverName: "linear",
        config: { url: "https://mcp.linear.app/sse", transport: "sse", auth: "oauth" },
        followUp: "oauth",
        docsUrl: "https://linear.app/docs/mcp",
      },
    },
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Crash alerts explained and triaged the moment they fire.",
    action: {
      kind: "mcp",
      mcp: {
        serverName: "sentry",
        config: { url: "https://mcp.sentry.dev/mcp", transport: "streamable-http", auth: "oauth" },
        followUp: "oauth",
        docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
      },
    },
  },
  {
    id: "home-assistant",
    name: "Home Assistant",
    description: "Control lights, climate, and automations across your whole home.",
    action: {
      kind: "mcp",
      mcp: {
        serverName: "home-assistant",
        config: {
          url: "http://homeassistant.local:8123/mcp_server/sse",
          transport: "sse",
        },
        followUp: "endpoint",
        docsUrl: "https://www.home-assistant.io/integrations/mcp_server/",
      },
    },
  },
  {
    id: "google-calendar",
    name: "Calendar",
    description: "Read, create, and get briefed on events — your agent owns your schedule.",
    action: { kind: "clawhub", query: "calendar" },
  },
  {
    id: "email-inbox",
    name: "Email",
    description: "Mailbox triage, summaries, and drafts with send-on-approval.",
    action: { kind: "clawhub", query: "email" },
  },
  {
    id: "spotify",
    name: "Spotify",
    description: "Search, queue, and soundtrack your day with mood-based playlists.",
    action: { kind: "clawhub", query: "spotify" },
  },
  {
    id: "sonos",
    name: "Sonos",
    description: "Whole-home audio: play, group rooms, and queue by chat.",
    action: { kind: "clawhub", query: "sonos" },
  },
  {
    id: "philips-hue",
    name: "Philips Hue",
    description: "Mood lighting on command — scenes, schedules, and color moods.",
    action: { kind: "clawhub", query: "hue" },
  },
  {
    id: "youtube",
    name: "YouTube",
    description: "Search, summarize, and pull transcripts from any video.",
    action: { kind: "clawhub", query: "youtube" },
  },
  {
    id: "grafana",
    name: "Grafana",
    description: "Query dashboards and alerts; get anomaly summaries in chat.",
    action: { kind: "clawhub", query: "grafana" },
  },
  {
    id: "portfolio-pulse",
    name: "Markets",
    description: "Live stocks and crypto with price alerts and daily digests.",
    action: { kind: "clawhub", query: "finance" },
  },
  {
    id: "trip-scout",
    name: "Travel",
    description: "Flight and hotel search with fare watching and trip memory.",
    action: { kind: "clawhub", query: "flights" },
  },
  {
    id: "morning-brief",
    name: "News",
    description: "A personalized daily briefing: news, weather, and tasks in one message.",
    action: { kind: "clawhub", query: "news" },
  },
];
