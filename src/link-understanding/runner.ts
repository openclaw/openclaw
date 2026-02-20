import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { LinkModelConfig, LinkToolsConfig } from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { CLI_OUTPUT_MAX_BUFFER } from "../media-understanding/defaults.js";
import { resolveTimeoutMs } from "../media-understanding/resolve.js";
import {
  normalizeMediaUnderstandingChatType,
  resolveMediaUnderstandingScope,
} from "../media-understanding/scope.js";
import { runExec } from "../process/exec.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { DEFAULT_LINK_TIMEOUT_SECONDS } from "./defaults.js";
import { extractLinksFromMessage } from "./detect.js";

export type LinkUnderstandingResult = {
  urls: string[];
  outputs: string[];
};

function resolveScopeDecision(params: {
  config?: LinkToolsConfig;
  ctx: MsgContext;
}): "allow" | "deny" {
  return resolveMediaUnderstandingScope({
    scope: params.config?.scope,
    sessionKey: params.ctx.SessionKey,
    channel: params.ctx.Surface ?? params.ctx.Provider,
    chatType: normalizeMediaUnderstandingChatType(params.ctx.ChatType),
  });
}

function resolveTimeoutMsFromConfig(params: {
  config?: LinkToolsConfig;
  entry: LinkModelConfig;
}): number {
  const configured = params.entry.timeoutSeconds ?? params.config?.timeoutSeconds;
  return resolveTimeoutMs(configured, DEFAULT_LINK_TIMEOUT_SECONDS);
}

async function runCliEntry(params: {
  entry: LinkModelConfig;
  ctx: MsgContext;
  url: string;
  config?: LinkToolsConfig;
}): Promise<string | null> {
  if ((params.entry.type ?? "cli") !== "cli") {
    return null;
  }
  const command = params.entry.command.trim();
  if (!command) {
    return null;
  }
  const args = params.entry.args ?? [];
  const timeoutMs = resolveTimeoutMsFromConfig({ config: params.config, entry: params.entry });
  const templCtx = {
    ...params.ctx,
    LinkUrl: params.url,
  };
  const argv = [command, ...args].map((part, index) =>
    index === 0 ? part : applyTemplate(part, templCtx),
  );

  if (shouldLogVerbose()) {
    logVerbose(`Link understanding via CLI: ${argv.join(" ")}`);
  }

  const { stdout } = await runExec(argv[0], argv.slice(1), {
    timeoutMs,
    maxBuffer: CLI_OUTPUT_MAX_BUFFER,
  });
  const trimmed = stdout.trim();
  return trimmed || null;
}

// ---------------------------------------------------------------------------
// Web search fallback
// ---------------------------------------------------------------------------

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_SEARCH_FALLBACK_MAX_RESULTS = 3;
const DEFAULT_SEARCH_FALLBACK_TIMEOUT_SECONDS = 15;

type BraveFallbackResult = {
  title?: string;
  url?: string;
  description?: string;
};

type BraveFallbackResponse = {
  web?: {
    results?: BraveFallbackResult[];
  };
};

/**
 * Resolve the Brave API key from config or environment, returning undefined
 * when unavailable.
 */
function resolveSearchFallbackApiKey(cfg?: OpenClawConfig): string | undefined {
  const fromConfig = cfg?.tools?.web?.search?.apiKey;
  const normalized =
    typeof fromConfig === "string" ? normalizeSecretInput(fromConfig) : "";
  const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
  return normalized || fromEnv || undefined;
}

/**
 * Build a search query from a URL by combining hostname keywords with
 * slug-decoded path segments.
 *
 * Example:
 *   https://loyaltylobby.com/2024/03/hilton-honors-changes
 *   → "loyaltylobby hilton honors changes"
 */
function buildSearchQueryFromUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Hostname without "www." and TLD-like suffixes (.com, .co.uk, etc.)
    const hostParts = parsed.hostname
      .replace(/^www\./, "")
      .split(".")
      .filter((p) => p.length > 3 || /[A-Z]/.test(p));
    const hostKeywords = hostParts.length > 0 ? hostParts.slice(0, 1) : [];

    // Path segments, stripping numeric-only parts (dates, ids)
    const pathParts = parsed.pathname
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .map((seg) => seg.replace(/[-_]+/g, " ").trim())
      .filter((seg) => seg && !/^\d+$/.test(seg));

    const parts = [...hostKeywords, ...pathParts];
    const query = parts.join(" ").replace(/\s+/g, " ").trim();
    return query || url;
  } catch {
    return url;
  }
}

/**
 * Perform a Brave Search API call and return a formatted text summary
 * including a disclaimer that it was derived from search results.
 */
async function runSearchFallback(params: {
  url: string;
  cfg: OpenClawConfig;
  config?: LinkToolsConfig;
}): Promise<string | null> {
  const fallbackCfg = params.config?.searchFallback;
  if (!fallbackCfg?.enabled) {
    return null;
  }

  const apiKey = resolveSearchFallbackApiKey(params.cfg);
  if (!apiKey) {
    if (shouldLogVerbose()) {
      logVerbose("Link search fallback skipped: no Brave API key available.");
    }
    return null;
  }

  const maxResults =
    fallbackCfg.maxResults ?? DEFAULT_SEARCH_FALLBACK_MAX_RESULTS;
  const timeoutSeconds =
    fallbackCfg.timeoutSeconds ?? DEFAULT_SEARCH_FALLBACK_TIMEOUT_SECONDS;

  const query = buildSearchQueryFromUrl(params.url);
  if (shouldLogVerbose()) {
    logVerbose(
      `Link search fallback for ${params.url} — query: "${query}"`,
    );
  }

  const searchUrl = new URL(BRAVE_SEARCH_ENDPOINT);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("count", String(maxResults));

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutSeconds * 1000,
  );

  try {
    const res = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      if (shouldLogVerbose()) {
        logVerbose(
          `Link search fallback HTTP error (${res.status}) for ${params.url}`,
        );
      }
      return null;
    }

    const data = (await res.json()) as BraveFallbackResponse;
    const results = Array.isArray(data.web?.results)
      ? data.web!.results.slice(0, maxResults)
      : [];

    if (results.length === 0) {
      if (shouldLogVerbose()) {
        logVerbose(`Link search fallback returned 0 results for ${params.url}`);
      }
      return null;
    }

    return formatSearchFallbackOutput(params.url, results);
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`Link search fallback error for ${params.url}: ${String(err)}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Format Brave Search results into a human-readable summary with a
 * disclaimer that the content was obtained via web search (not direct
 * page access).
 */
function formatSearchFallbackOutput(
  originalUrl: string,
  results: BraveFallbackResult[],
): string {
  const lines: string[] = [];
  lines.push(
    `[Web Search Fallback] Direct access failed. Summarized from web search results: ${originalUrl}`,
  );
  lines.push("");

  for (const r of results) {
    const title = r.title?.trim();
    const desc = r.description?.trim();
    const url = r.url?.trim();
    if (!title && !desc) {
      continue;
    }
    if (title) {
      lines.push(`• ${title}`);
    }
    if (desc) {
      lines.push(`  ${desc}`);
    }
    if (url && url !== originalUrl) {
      lines.push(`  ${url}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------

async function runLinkEntries(params: {
  entries: LinkModelConfig[];
  ctx: MsgContext;
  url: string;
  config?: LinkToolsConfig;
  cfg?: OpenClawConfig;
}): Promise<string | null> {
  let lastError: unknown;
  for (const entry of params.entries) {
    try {
      const output = await runCliEntry({
        entry,
        ctx: params.ctx,
        url: params.url,
        config: params.config,
      });
      if (output) {
        return output;
      }
    } catch (err) {
      lastError = err;
      if (shouldLogVerbose()) {
        logVerbose(`Link understanding failed for ${params.url}: ${String(err)}`);
      }
    }
  }
  if (lastError && shouldLogVerbose()) {
    logVerbose(`Link understanding exhausted for ${params.url}`);
  }

  // Web search fallback: try when CLI entries threw errors (lastError truthy).
  if (lastError && params.cfg) {
    const fallback = await runSearchFallback({
      url: params.url,
      cfg: params.cfg,
      config: params.config,
    });
    if (fallback) {
      if (shouldLogVerbose()) {
        logVerbose(`Link search fallback succeeded for ${params.url}`);
      }
      return fallback;
    }
  }

  return null;
}

export async function runLinkUnderstanding(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  message?: string;
}): Promise<LinkUnderstandingResult> {
  const config = params.cfg.tools?.links;
  if (!config || config.enabled === false) {
    return { urls: [], outputs: [] };
  }

  const scopeDecision = resolveScopeDecision({ config, ctx: params.ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose("Link understanding disabled by scope policy.");
    }
    return { urls: [], outputs: [] };
  }

  const message = params.message ?? params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body;
  const links = extractLinksFromMessage(message ?? "", { maxLinks: config?.maxLinks });
  if (links.length === 0) {
    return { urls: [], outputs: [] };
  }

  const entries = config?.models ?? [];
  if (entries.length === 0) {
    return { urls: links, outputs: [] };
  }

  const outputs: string[] = [];
  for (const url of links) {
    const output = await runLinkEntries({
      entries,
      ctx: params.ctx,
      url,
      config,
      cfg: params.cfg,
    });
    if (output) {
      outputs.push(output);
    }
  }

  return { urls: links, outputs };
}

export const __testing = {
  buildSearchQueryFromUrl,
  formatSearchFallbackOutput,
} as const;
