import { Type } from "@sinclair/typebox";
import {
  __testing as xaiXSearchTesting,
  buildXaiXSearchPayload,
  requestXaiXSearch,
  resolveXaiXSearchInlineCitations,
  resolveXaiXSearchMaxTurns,
  resolveXaiXSearchModel,
  type XaiXSearchOptions,
} from "../../../extensions/xai/src/x-search-shared.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveProviderWebSearchPluginConfig } from "../../plugin-sdk/provider-web-search.js";
import type { RuntimeWebXSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { jsonResult, readStringArrayParam, readStringParam, ToolInputError } from "./common.js";
import {
  readConfiguredSecretString,
  readProviderEnvValue,
  SEARCH_CACHE,
} from "./web-search-provider-common.js";
import { readCache, resolveCacheTtlMs, resolveTimeoutSeconds, writeCache } from "./web-shared.js";

type XSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { x_search?: infer XSearch }
    ? XSearch
    : undefined
  : undefined;

function readLegacyGrokApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const grok = (search as Record<string, unknown>).grok;
  return readConfiguredSecretString(
    grok && typeof grok === "object" ? (grok as Record<string, unknown>).apiKey : undefined,
    "tools.web.search.grok.apiKey",
  );
}

function readPluginXaiWebSearchApiKey(cfg?: OpenClawConfig): string | undefined {
  return readConfiguredSecretString(
    resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")?.apiKey,
    "plugins.entries.xai.config.webSearch.apiKey",
  );
}

function resolveFallbackXaiApiKey(cfg?: OpenClawConfig): string | undefined {
  return readPluginXaiWebSearchApiKey(cfg) ?? readLegacyGrokApiKey(cfg);
}

function resolveXSearchConfig(cfg?: OpenClawConfig): XSearchConfig {
  const xSearch = cfg?.tools?.web?.x_search;
  if (!xSearch || typeof xSearch !== "object") {
    return undefined;
  }
  return xSearch as XSearchConfig;
}

function resolveXSearchEnabled(params: {
  cfg?: OpenClawConfig;
  config?: XSearchConfig;
  runtimeXSearch?: RuntimeWebXSearchMetadata;
}): boolean {
  if (params.config?.enabled === false) {
    return false;
  }
  if (params.runtimeXSearch?.active) {
    return true;
  }
  const configuredApiKey = readConfiguredSecretString(
    params.config?.apiKey,
    "tools.web.x_search.apiKey",
  );
  return Boolean(
    configuredApiKey ||
    resolveFallbackXaiApiKey(params.cfg) ||
    readProviderEnvValue(["XAI_API_KEY"]),
  );
}

function resolveXSearchApiKey(config?: XSearchConfig, cfg?: OpenClawConfig): string | undefined {
  return (
    readConfiguredSecretString(config?.apiKey, "tools.web.x_search.apiKey") ??
    resolveFallbackXaiApiKey(cfg) ??
    readProviderEnvValue(["XAI_API_KEY"])
  );
}

function normalizeOptionalIsoDate(value: string | undefined, label: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new ToolInputError(`${label} must use YYYY-MM-DD`);
  }
  const [year, month, day] = trimmed.split("-").map((entry) => Number.parseInt(entry, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ToolInputError(`${label} must be a valid calendar date`);
  }
  return trimmed;
}

function buildXSearchCacheKey(params: {
  query: string;
  model: string;
  inlineCitations: boolean;
  maxTurns?: number;
  options: Omit<XaiXSearchOptions, "query">;
}) {
  return JSON.stringify([
    "x_search",
    params.model,
    params.query,
    params.inlineCitations,
    params.maxTurns ?? null,
    params.options.allowedXHandles ?? null,
    params.options.excludedXHandles ?? null,
    params.options.fromDate ?? null,
    params.options.toDate ?? null,
    params.options.enableImageUnderstanding ?? false,
    params.options.enableVideoUnderstanding ?? false,
  ]);
}

export function createXSearchTool(options?: {
  config?: OpenClawConfig;
  runtimeXSearch?: RuntimeWebXSearchMetadata;
}) {
  const xSearchConfig = resolveXSearchConfig(options?.config);
  if (
    !resolveXSearchEnabled({
      cfg: options?.config,
      config: xSearchConfig,
      runtimeXSearch: options?.runtimeXSearch,
    })
  ) {
    return null;
  }

  return {
    label: "X Search",
    name: "x_search",
    description:
      "Search X (formerly Twitter) using xAI. Returns AI-synthesized answers with citations from real-time X post search.",
    parameters: Type.Object({
      query: Type.String({ description: "X search query string." }),
      allowed_x_handles: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Only include posts from these X handles.",
        }),
      ),
      excluded_x_handles: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Exclude posts from these X handles.",
        }),
      ),
      from_date: Type.Optional(
        Type.String({ description: "Only include posts on or after this date (YYYY-MM-DD)." }),
      ),
      to_date: Type.Optional(
        Type.String({ description: "Only include posts on or before this date (YYYY-MM-DD)." }),
      ),
      enable_image_understanding: Type.Optional(
        Type.Boolean({ description: "Allow xAI to inspect images attached to matching posts." }),
      ),
      enable_video_understanding: Type.Optional(
        Type.Boolean({ description: "Allow xAI to inspect videos attached to matching posts." }),
      ),
    }),
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const apiKey = resolveXSearchApiKey(xSearchConfig, options?.config);
      if (!apiKey) {
        return jsonResult({
          error: "missing_xai_api_key",
          message:
            "x_search needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.x_search.apiKey or plugins.entries.xai.config.webSearch.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }

      const query = readStringParam(args, "query", { required: true });
      const allowedXHandles = readStringArrayParam(args, "allowed_x_handles");
      const excludedXHandles = readStringArrayParam(args, "excluded_x_handles");
      const fromDate = normalizeOptionalIsoDate(readStringParam(args, "from_date"), "from_date");
      const toDate = normalizeOptionalIsoDate(readStringParam(args, "to_date"), "to_date");
      if (fromDate && toDate && fromDate > toDate) {
        throw new ToolInputError("from_date must be on or before to_date");
      }

      const xSearchOptions: XaiXSearchOptions = {
        query,
        allowedXHandles,
        excludedXHandles,
        fromDate,
        toDate,
        enableImageUnderstanding: args.enable_image_understanding === true,
        enableVideoUnderstanding: args.enable_video_understanding === true,
      };
      const xSearchConfigRecord = xSearchConfig as Record<string, unknown> | undefined;
      const model = resolveXaiXSearchModel(xSearchConfigRecord);
      const inlineCitations = resolveXaiXSearchInlineCitations(xSearchConfigRecord);
      const maxTurns = resolveXaiXSearchMaxTurns(xSearchConfigRecord);
      const cacheKey = buildXSearchCacheKey({
        query,
        model,
        inlineCitations,
        maxTurns,
        options: {
          allowedXHandles,
          excludedXHandles,
          fromDate,
          toDate,
          enableImageUnderstanding: xSearchOptions.enableImageUnderstanding,
          enableVideoUnderstanding: xSearchOptions.enableVideoUnderstanding,
        },
      });
      const cached = readCache(SEARCH_CACHE, cacheKey);
      if (cached) {
        return jsonResult({ ...cached.value, cached: true });
      }

      const startedAt = Date.now();
      const result = await requestXaiXSearch({
        apiKey,
        model,
        timeoutSeconds: resolveTimeoutSeconds(xSearchConfig?.timeoutSeconds, 30),
        inlineCitations,
        maxTurns,
        options: xSearchOptions,
      });
      const payload = buildXaiXSearchPayload({
        query,
        model,
        tookMs: Date.now() - startedAt,
        content: result.content,
        citations: result.citations,
        inlineCitations: result.inlineCitations,
        options: xSearchOptions,
      });
      writeCache(
        SEARCH_CACHE,
        cacheKey,
        payload,
        resolveCacheTtlMs(xSearchConfig?.cacheTtlMinutes, 15),
      );
      return jsonResult(payload);
    },
  };
}

export const __testing = {
  buildXSearchCacheKey,
  normalizeOptionalIsoDate,
  resolveXSearchApiKey,
  resolveXSearchConfig,
  resolveXSearchEnabled,
  ...xaiXSearchTesting,
} as const;
