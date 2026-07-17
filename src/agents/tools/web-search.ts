/**
 * web_search built-in tool.
 *
 * Runs the configured runtime provider and returns normalized cached search results.
 */
import type { Static } from "typebox";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { runtimeWebSecretOwnerId } from "../../secrets/runtime-web-secret-owner.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { runWebSearch } from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult } from "./common.js";
import { MAX_SEARCH_COUNT } from "./web-search-provider-common.js";
import { resolveWebSearchToolRuntimeContext } from "./web-tool-runtime-context.js";

const WebSearchSchema = {
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

const WebSearchExternalContentSchema = Type.Object(
  {
    untrusted: Type.Literal(true),
    source: Type.Literal("web_search"),
    wrapped: Type.Literal(true),
    provider: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
type WebSearchExternalContent = Static<typeof WebSearchExternalContentSchema>;

const WebSearchResultSchema = Type.Object(
  {
    title: Type.String(),
    url: Type.String(),
    snippet: Type.Optional(Type.String()),
    published: Type.Optional(Type.String()),
    siteName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const WebSearchCitationSchema = Type.Object(
  {
    url: Type.String(),
    title: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WebSearchOutputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("error"),
      provider: Type.String(),
      error: Type.String(),
      message: Type.String(),
      docs: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("results"),
      provider: Type.String(),
      query: Type.String(),
      queryTerms: Type.Optional(Type.Array(Type.String())),
      count: Type.Number(),
      tookMs: Type.Optional(Type.Number()),
      results: Type.Array(WebSearchResultSchema),
      externalContent: WebSearchExternalContentSchema,
      cached: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("answer"),
      provider: Type.String(),
      query: Type.String(),
      tookMs: Type.Optional(Type.Number()),
      content: Type.String(),
      citations: Type.Optional(Type.Array(WebSearchCitationSchema)),
      externalContent: WebSearchExternalContentSchema,
      cached: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
]);

export type WebSearchOutput = Static<typeof WebSearchOutputSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeExternalContent(raw: Record<string, unknown>): WebSearchExternalContent {
  const externalContent = isRecord(raw.externalContent) ? raw.externalContent : undefined;
  return {
    untrusted: true,
    source: "web_search",
    wrapped: true,
    ...(typeof externalContent?.provider === "string"
      ? { provider: externalContent.provider }
      : {}),
  };
}

function normalizeCitations(value: unknown): Array<{ url: string; title?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ url: entry }];
    }
    if (!isRecord(entry) || typeof entry.url !== "string") {
      return [];
    }
    return [
      {
        url: entry.url,
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      },
    ];
  });
}

/** Normalizes every bundled or external provider payload at the core tool boundary. */
export function normalizeWebSearchOutput(params: {
  result: Record<string, unknown>;
  provider: string;
  query: string;
}): WebSearchOutput {
  const { result, provider } = params;
  const tookMs = readFiniteNumber(result.tookMs);
  const cached = result.cached === true ? true : undefined;
  const queryTerms = Array.isArray(result.searchQueries)
    ? result.searchQueries.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const query =
    queryTerms !== undefined
      ? (queryTerms[0] ?? params.query)
      : typeof result.query === "string"
        ? result.query
        : params.query;

  if (Array.isArray(result.results)) {
    const results = result.results.map((entry) => {
      const row = isRecord(entry) ? entry : {};
      const snippet =
        typeof row.snippet === "string"
          ? row.snippet
          : typeof row.description === "string"
            ? row.description
            : Array.isArray(row.snippets)
              ? row.snippets.find((value): value is string => typeof value === "string")
              : undefined;
      return {
        title: typeof row.title === "string" ? row.title : "",
        url: typeof row.url === "string" ? row.url : "",
        ...(snippet !== undefined ? { snippet } : {}),
        ...(typeof row.published === "string" ? { published: row.published } : {}),
        ...(typeof row.siteName === "string" ? { siteName: row.siteName } : {}),
      };
    });
    return {
      kind: "results",
      provider,
      query,
      ...(queryTerms !== undefined ? { queryTerms } : {}),
      count: readFiniteNumber(result.count) ?? results.length,
      ...(tookMs !== undefined ? { tookMs } : {}),
      results,
      externalContent: normalizeExternalContent(result),
      ...(cached ? { cached } : {}),
    };
  }

  if (typeof result.content === "string") {
    const citations = normalizeCitations(result.citations);
    return {
      kind: "answer",
      provider,
      query,
      ...(tookMs !== undefined ? { tookMs } : {}),
      content: result.content,
      ...(citations !== undefined ? { citations } : {}),
      externalContent: normalizeExternalContent(result),
      ...(cached ? { cached } : {}),
    };
  }

  if (Object.hasOwn(result, "error")) {
    const error = typeof result.error === "string" ? result.error : "provider_error";
    return {
      kind: "error",
      provider,
      error,
      message: typeof result.message === "string" ? result.message : error,
      ...(typeof result.docs === "string" ? { docs: result.docs } : {}),
    };
  }

  return {
    kind: "error",
    provider,
    error: "unrecognized_provider_result",
    message: `Web search provider "${provider}" returned an unrecognized result.`,
  };
}

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

  return {
    label: "Web Search",
    name: "web_search",
    description: "Search current web; normalized provider results.",
    parameters: WebSearchSchema,
    outputSchema: WebSearchOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      // Late binding lets long-lived agents pick up runtime web-search credentials/config without
      // rebuilding the tool object.
      const { config, preferRuntimeProviders, providerSelectionId, runtimeWebSearch } =
        resolveWebSearchToolRuntimeContext({
          config: options?.config,
          lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
          runtimeWebSearch: options?.runtimeWebSearch,
        });
      if (isWebSearchDisabled(config)) {
        throw new Error("web_search is disabled.");
      }
      if (providerSelectionId) {
        assertSecretOwnerAvailable(
          "capability",
          runtimeWebSecretOwnerId("search", providerSelectionId),
        );
      }
      const toolArgs = asToolParamsRecord(args);
      const result = await runWebSearch({
        config,
        agentDir: options?.agentDir,
        sandboxed: options?.sandboxed,
        runtimeWebSearch,
        preferRuntimeProviders,
        args: toolArgs,
        signal,
      });
      return jsonResult(
        normalizeWebSearchOutput({
          result: result.result,
          provider: result.provider,
          query: typeof toolArgs.query === "string" ? toolArgs.query : "",
        }),
      );
    },
  };
}
