import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWebSearch } from "../web-search/runtime.js";
import type {
  CourseCreatorLiveSearchReport,
  CourseCreatorResearchPackClaimInput,
  CourseCreatorResearchPackInput,
  CourseCreatorResearchPackSourceInput,
} from "./package.js";
import { slugifyCourseTopic } from "./package.js";

export type CourseCreatorLiveSearchRunResult = {
  provider: string;
  result: Record<string, unknown>;
};

export type CourseCreatorLiveSearchRunner = (params: {
  query: string;
  count: number;
  providerId?: string;
  config?: OpenClawConfig;
  signal?: AbortSignal;
}) => Promise<CourseCreatorLiveSearchRunResult>;

export type CourseCreatorLiveSearchPackResult = {
  researchPack?: CourseCreatorResearchPackInput;
  report: CourseCreatorLiveSearchReport;
};

type NormalizedSearchResult = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unwrapExternalContent(value: string): string {
  const lines = value.split(/\r?\n/u);
  const separatorIndex = lines.findIndex((line) => line === "---");
  const endIndex = lines.findIndex(
    (line, index) => index > separatorIndex && line.startsWith("<<<END_EXTERNAL_UNTRUSTED_CONTENT"),
  );
  if (separatorIndex >= 0 && endIndex > separatorIndex) {
    return lines
      .slice(separatorIndex + 1, endIndex)
      .join("\n")
      .trim();
  }
  return value.trim();
}

function normalizeText(value: unknown): string {
  return unwrapExternalContent(readString(value)).replace(/\s+/gu, " ").trim();
}

function readResultSnippet(result: Record<string, unknown>): string {
  const direct = normalizeText(result.snippet ?? result.description ?? result.text);
  if (direct) {
    return direct;
  }
  const snippets = result.snippets;
  if (Array.isArray(snippets)) {
    return snippets.map(normalizeText).filter(Boolean).join(" ");
  }
  return "";
}

function isHttpSourceUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeSearchResults(payload: Record<string, unknown>): NormalizedSearchResult[] {
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results
    .filter(isRecord)
    .map((result) => {
      const url = readString(result.url);
      const title = normalizeText(result.title) || url;
      return {
        title,
        url,
        snippet: readResultSnippet(result),
        siteName: normalizeText(result.siteName),
      };
    })
    .filter((result) => result.title && isHttpSourceUrl(result.url));
}

function sourceTierForUrl(url: string): "A" | "B" {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname.endsWith(".gov") || hostname.endsWith(".edu") || hostname.endsWith(".org")
    ? "A"
    : "B";
}

function credibilityForUrl(url: string): number {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname.endsWith(".gov") || hostname.endsWith(".edu")) {
    return 92;
  }
  if (hostname.endsWith(".org")) {
    return 88;
  }
  return 86;
}

function buildSourceContent(params: {
  topic: string;
  provider: string;
  query: string;
  result: NormalizedSearchResult;
}): string {
  return [
    `Topic: ${params.topic}`,
    `Search provider: ${params.provider}`,
    `Search query: ${params.query}`,
    `Title: ${params.result.title}`,
    `URL: ${params.result.url}`,
    `Site: ${params.result.siteName || new URL(params.result.url).hostname}`,
    `Snippet: ${params.result.snippet || "No snippet returned by the search provider."}`,
    "Limitation: this snapshot is live search-result metadata, not full page extraction.",
  ].join("\n");
}

function buildLiveSearchResearchPack(params: {
  topic: string;
  provider: string;
  query: string;
  results: NormalizedSearchResult[];
}): CourseCreatorResearchPackInput {
  const sources: CourseCreatorResearchPackSourceInput[] = params.results.map((result, index) => {
    const id = `live-search-${String(index + 1).padStart(2, "0")}-${slugifyCourseTopic(
      result.siteName || new URL(result.url).hostname,
    ).slice(0, 48)}`;
    return {
      id,
      title: result.title,
      url: result.url,
      publisher: result.siteName || new URL(result.url).hostname,
      tier: sourceTierForUrl(result.url),
      credibilityScore: credibilityForUrl(result.url),
      license: "live-search-result-metadata",
      content: buildSourceContent({
        topic: params.topic,
        provider: params.provider,
        query: params.query,
        result,
      }),
    };
  });

  const claims: CourseCreatorResearchPackClaimInput[] = sources.slice(0, 3).map((source) => ({
    id: `claim-${source.id}`,
    text: `The live search provider returned "${source.title}" as an accepted source candidate for ${params.topic}.`,
    sourceIds: [source.id],
  }));

  return { schemaVersion: 1, sources, claims };
}

function blockedReport(params: {
  provider: string | null;
  query: string;
  searchedAt: string;
  resultCount?: number;
  error: string;
}): CourseCreatorLiveSearchReport {
  return {
    status: "blocked",
    provider: params.provider,
    query: params.query,
    resultCount: params.resultCount ?? 0,
    sourceIds: [],
    searchedAt: params.searchedAt,
    error: params.error,
    requiredHumanActions: [
      "Configure a working web_search provider and credentials if required.",
      "Verify network access from the Course Creator runtime.",
      "Rerun live source discovery until at least two source candidates are accepted.",
    ],
  };
}

async function defaultLiveSearchRunner(params: {
  query: string;
  count: number;
  providerId?: string;
  config?: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<CourseCreatorLiveSearchRunResult> {
  return await runWebSearch({
    config: params.config,
    providerId: params.providerId,
    args: { query: params.query, count: params.count },
    sandboxed: true,
    signal: params.signal,
  });
}

export async function createCourseCreatorLiveSearchPack(params: {
  topic: string;
  providerId?: string;
  count?: number;
  config?: OpenClawConfig;
  now?: Date;
  signal?: AbortSignal;
  runSearch?: CourseCreatorLiveSearchRunner;
}): Promise<CourseCreatorLiveSearchPackResult> {
  const searchedAt = (params.now ?? new Date()).toISOString();
  const query = `${params.topic} credible beginner course sources`;
  const count = Math.max(2, Math.min(10, Math.floor(params.count ?? 5)));
  const runSearch = params.runSearch ?? defaultLiveSearchRunner;

  let searchResult: CourseCreatorLiveSearchRunResult;
  try {
    searchResult = await runSearch({
      query,
      count,
      providerId: params.providerId,
      config: params.config,
      signal: params.signal,
    });
  } catch (error) {
    return {
      report: blockedReport({
        provider: params.providerId ?? null,
        query,
        searchedAt,
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  const provider = searchResult.provider || params.providerId || null;
  const providerError = readString(searchResult.result.error);
  if (providerError) {
    return {
      report: blockedReport({
        provider,
        query,
        searchedAt,
        error:
          readString(searchResult.result.message) ||
          `web_search provider returned ${providerError}.`,
      }),
    };
  }

  const results = normalizeSearchResults(searchResult.result).slice(0, count);
  if (results.length < 2) {
    return {
      report: blockedReport({
        provider,
        query,
        searchedAt,
        resultCount: results.length,
        error: "Live web_search returned fewer than two accepted HTTP(S) source candidates.",
      }),
    };
  }

  const researchPack = buildLiveSearchResearchPack({
    topic: params.topic,
    provider: provider ?? "unknown",
    query,
    results,
  });
  return {
    researchPack,
    report: {
      status: "pass",
      provider,
      query,
      resultCount: results.length,
      sourceIds: researchPack.sources.map((source) => source.id),
      searchedAt,
      requiredHumanActions: [
        "Add guarded live page fetching and extraction before production course generation.",
      ],
    },
  };
}

export const __testing = {
  normalizeSearchResults,
};
