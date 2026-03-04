import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { withTrustedWebToolsEndpoint } from "./web-guarded-fetch.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  writeCache,
} from "./web-shared.js";

const YOU_RESEARCH_ENDPOINT = "https://api.you.com/v1/research";
const RESEARCH_EFFORTS = ["lite", "standard", "deep", "exhaustive"] as const;

type ResearchEffort = (typeof RESEARCH_EFFORTS)[number];

const EFFORT_TIMEOUT_SECONDS: Record<ResearchEffort, number> = {
  lite: 60,
  standard: 120,
  deep: 360,
  exhaustive: 600,
};

const RESEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const WebResearchSchema = Type.Object({
  input: Type.String({
    description:
      "The research question or complex query requiring in-depth investigation and multi-step reasoning.",
  }),
  research_effort: optionalStringEnum(RESEARCH_EFFORTS, {
    description:
      'Controls research depth. "lite" = fast answers, "standard" = balanced (default), "deep" = thorough, "exhaustive" = most comprehensive.',
    default: "standard",
  }),
});

type WebResearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { research?: infer Research }
    ? Research
    : undefined
  : undefined;

function resolveResearchConfig(cfg?: OpenClawConfig): WebResearchConfig {
  const research = cfg?.tools?.web?.research;
  if (!research || typeof research !== "object") {
    return undefined;
  }
  return research as WebResearchConfig;
}

function resolveResearchApiKey(research?: WebResearchConfig): string | undefined {
  const fromConfig =
    research && "apiKey" in research && typeof research.apiKey === "string"
      ? normalizeSecretInput(research.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.YDC_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function resolveResearchEnabled(params: {
  research?: WebResearchConfig;
  apiKey?: string;
}): boolean {
  if (typeof params.research?.enabled === "boolean") {
    return params.research.enabled;
  }
  return Boolean(params.apiKey);
}

function resolveDefaultEffort(research?: WebResearchConfig): ResearchEffort {
  const raw =
    research && "defaultEffort" in research && typeof research.defaultEffort === "string"
      ? research.defaultEffort.trim().toLowerCase()
      : "";
  if (RESEARCH_EFFORTS.includes(raw as ResearchEffort)) {
    return raw as ResearchEffort;
  }
  return "standard";
}

type YouResearchResponse = {
  output?: {
    content?: string;
    content_type?: string;
    sources?: Array<{
      url?: string;
      title?: string;
      snippets?: string[];
    }>;
  };
};

async function runResearch(params: {
  input: string;
  effort: ResearchEffort;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(`research:${params.input}:${params.effort}`);
  const cached = readCache(RESEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  const result = await withTrustedWebToolsEndpoint(
    {
      url: YOU_RESEARCH_ENDPOINT,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": params.apiKey,
        },
        body: JSON.stringify({
          input: params.input,
          research_effort: params.effort,
        }),
      },
      timeoutSeconds: params.timeoutSeconds,
    },
    async ({ response: res }) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        const detail = detailResult.text;
        throw new Error(`You.com Research API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as YouResearchResponse;
      const content = data.output?.content ?? "No response";
      const sources = (data.output?.sources ?? [])
        .filter((s) => typeof s.url === "string" && s.url)
        .map((s) => ({
          url: s.url!,
          title: s.title ? wrapWebContent(s.title, "web_research") : undefined,
        }));

      return {
        input: params.input,
        effort: params.effort,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_research",
          wrapped: true,
        },
        content: wrapWebContent(content, "web_research"),
        sources,
      };
    },
  );

  writeCache(RESEARCH_CACHE, cacheKey, result, params.cacheTtlMs);
  return result;
}

export function createWebResearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const research = resolveResearchConfig(options?.config);
  const apiKey = resolveResearchApiKey(research);
  if (!resolveResearchEnabled({ research, apiKey })) {
    return null;
  }

  const defaultEffort = resolveDefaultEffort(research);

  return {
    label: "Web Research",
    name: "web_research",
    description:
      "Deep web research on complex queries. Returns comprehensive, cited answers from multi-step web investigation. Use for questions that need thorough research rather than a simple search.",
    parameters: WebResearchSchema,
    execute: async (_toolCallId, args) => {
      if (!apiKey) {
        return jsonResult({
          error: "missing_ydc_api_key",
          message:
            "web_research needs a You.com API key. Set YDC_API_KEY in the Gateway environment, or configure tools.web.research.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const params = args as Record<string, unknown>;
      const input = readStringParam(params, "input", { required: true });
      const rawEffort = readStringParam(params, "research_effort");
      const effort: ResearchEffort =
        rawEffort && RESEARCH_EFFORTS.includes(rawEffort as ResearchEffort)
          ? (rawEffort as ResearchEffort)
          : defaultEffort;

      const timeoutSeconds =
        typeof research?.timeoutSeconds === "number" && Number.isFinite(research.timeoutSeconds)
          ? Math.max(1, Math.floor(research.timeoutSeconds))
          : EFFORT_TIMEOUT_SECONDS[effort];

      const result = await runResearch({
        input,
        effort,
        apiKey,
        timeoutSeconds,
        cacheTtlMs: resolveCacheTtlMs(research?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  resolveResearchApiKey,
  resolveResearchEnabled,
} as const;
