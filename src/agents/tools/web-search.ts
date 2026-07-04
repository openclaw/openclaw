/**
 * web_search built-in tool.
 *
 * Runs the configured runtime provider and returns normalized cached search results.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import {
  resolveWebSearchProviderId,
  resolveWebSearchToolSchema,
  runWebSearch,
} from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult } from "./common.js";
import { MAX_SEARCH_COUNT, SEARCH_CACHE } from "./web-search-provider-common.js";
import { resolveWebSearchToolRuntimeContext } from "./web-tool-runtime-context.js";

// Back-compat fallback schema. When a concrete provider can be resolved at
// build time, resolveWebSearchToolSchema returns that provider's own (more
// accurate) schema instead. This union is advertised only when no provider is
// active yet (before startup activation, or when nothing is configured /
// detected). It intentionally keeps every historically shipped parameter so the
// model never loses parameters it had before this fast path existed; keep it as
// the union of provider-specific knobs.
const WEB_SEARCH_FALLBACK_SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "Search query." },
    count: {
      type: "number",
      description: "Result count.",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    },
    country: {
      type: "string",
      description: "2-letter country code.",
    },
    language: {
      type: "string",
      description: "ISO 639-1 language.",
    },
    freshness: {
      type: "string",
      description: "Time filter: day/week/month/year.",
    },
    date_after: {
      type: "string",
      description: "Published after YYYY-MM-DD.",
    },
    date_before: {
      type: "string",
      description: "Published before YYYY-MM-DD.",
    },
    search_lang: {
      type: "string",
      description: "Brave result language.",
    },
    ui_lang: {
      type: "string",
      description: "Brave UI locale.",
    },
    domain_filter: {
      type: "array",
      items: { type: "string" },
      description: "Perplexity domain filter.",
    },
    max_tokens: {
      type: "number",
      description: "Perplexity total token budget.",
      minimum: 1,
      maximum: 1000000,
    },
    max_tokens_per_page: {
      type: "number",
      description: "Perplexity tokens per page.",
      minimum: 1,
    },
  },
} satisfies Record<string, unknown>;

function isWebSearchDisabled(config?: OpenClawConfig): boolean {
  const search = config?.tools?.web?.search;
  return Boolean(search && typeof search === "object" && search.enabled === false);
}

/** Creates the `web_search` tool, or `null` when web search is disabled by config. */
export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  lateBindRuntimeConfig?: boolean;
}): AnyAgentTool | null {
  if (isWebSearchDisabled(options?.config)) {
    return null;
  }

  // Advertise the schema of the provider this tool would actually use, so the
  // model sees provider-accurate parameters instead of a hand-maintained
  // superset. Uses the same late-bound runtime context as execution; falls back
  // to the generic base schema when no concrete provider resolves.
  const schemaContext = resolveWebSearchToolRuntimeContext({
    config: options?.config,
    lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
    runtimeWebSearch: options?.runtimeWebSearch,
  });
  const parameters =
    resolveWebSearchToolSchema({
      config: schemaContext.config,
      agentDir: options?.agentDir,
      sandboxed: options?.sandboxed,
      runtimeWebSearch: schemaContext.runtimeWebSearch,
      preferRuntimeProviders: schemaContext.preferRuntimeProviders,
    }) ?? WEB_SEARCH_FALLBACK_SCHEMA;

  return {
    label: "Web Search",
    name: "web_search",
    description: "Search web for current info; returns normalized provider results.",
    parameters,
    execute: async (_toolCallId, args, signal) => {
      // Late binding lets long-lived agents pick up runtime web-search credentials/config without
      // rebuilding the tool object.
      const { config, preferRuntimeProviders, runtimeWebSearch } =
        resolveWebSearchToolRuntimeContext({
          config: options?.config,
          lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
          runtimeWebSearch: options?.runtimeWebSearch,
        });
      if (isWebSearchDisabled(config)) {
        throw new Error("web_search is disabled.");
      }
      const result = await runWebSearch({
        config,
        agentDir: options?.agentDir,
        sandboxed: options?.sandboxed,
        runtimeWebSearch,
        preferRuntimeProviders,
        args: asToolParamsRecord(args),
        signal,
      });
      return jsonResult({
        ...result.result,
        provider: result.provider,
      });
    },
  };
}

export const testing = {
  SEARCH_CACHE,
  resolveSearchProvider: (search?: Parameters<typeof resolveWebSearchProviderId>[0]["search"]) =>
    resolveWebSearchProviderId({ search }),
};
export { testing as __testing };
