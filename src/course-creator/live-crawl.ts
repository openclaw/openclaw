import { createWebFetchTool } from "../agents/tools/web-fetch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  CourseCreatorLiveCrawlReport,
  CourseCreatorResearchPackClaimInput,
  CourseCreatorResearchPackInput,
  CourseCreatorResearchPackSourceInput,
} from "./package.js";

export type CourseCreatorLiveCrawlFetchResult = {
  sourceId: string;
  url: string;
  result: Record<string, unknown>;
};

export type CourseCreatorLiveCrawlRunner = (params: {
  source: CourseCreatorResearchPackSourceInput;
  maxChars: number;
  config?: OpenClawConfig;
  signal?: AbortSignal;
}) => Promise<CourseCreatorLiveCrawlFetchResult>;

export type CourseCreatorLiveCrawlPackResult = {
  researchPack?: CourseCreatorResearchPackInput;
  report: CourseCreatorLiveCrawlReport;
};

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

function normalizeFetchedText(value: unknown): string {
  return unwrapExternalContent(readString(value)).replace(/\s+/gu, " ").trim();
}

function blockedReport(params: {
  requested: number;
  fetched?: number;
  sourceIds?: string[];
  semanticClaimsExtracted?: number;
  semanticClaimSourceIds?: string[];
  crawledAt: string;
  failures: CourseCreatorLiveCrawlReport["failures"];
}): CourseCreatorLiveCrawlReport {
  return {
    status: "blocked",
    requested: params.requested,
    fetched: params.fetched ?? 0,
    sourceIds: params.sourceIds ?? [],
    semanticClaimsExtracted: params.semanticClaimsExtracted ?? 0,
    semanticClaimSourceIds: params.semanticClaimSourceIds ?? [],
    crawledAt: params.crawledAt,
    failures: params.failures,
    requiredHumanActions: [
      "Resolve live page fetch or extraction failures.",
      "Verify accepted source URLs are reachable through guarded web_fetch.",
      "Rerun live page crawl until at least two source pages are extracted.",
    ],
  };
}

export function createBlockedCourseCreatorLiveCrawlReport(params: {
  requested: number;
  crawledAt: string;
  error: string;
}): CourseCreatorLiveCrawlReport {
  return blockedReport({
    requested: params.requested,
    crawledAt: params.crawledAt,
    failures: [
      {
        sourceId: "live-search-prerequisite",
        url: "",
        error: params.error,
      },
    ],
  });
}

async function defaultLiveCrawlRunner(params: {
  source: CourseCreatorResearchPackSourceInput;
  maxChars: number;
  config?: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<CourseCreatorLiveCrawlFetchResult> {
  const tool = createWebFetchTool({ config: params.config, sandboxed: true });
  if (!tool) {
    throw new Error("web_fetch is disabled.");
  }
  const result = await tool.execute(
    `course-creator:live-crawl:${params.source.id}`,
    {
      url: params.source.url,
      extractMode: "text",
      maxChars: params.maxChars,
    },
    params.signal,
  );
  return {
    sourceId: params.source.id,
    url: params.source.url,
    result:
      result.details && typeof result.details === "object"
        ? (result.details as Record<string, unknown>)
        : {},
  };
}

function buildCrawledSourceContent(params: {
  source: CourseCreatorResearchPackSourceInput;
  fetchResult: Record<string, unknown>;
  extractedText: string;
}): string {
  return [
    `Title: ${params.source.title}`,
    `URL: ${params.source.url}`,
    `Final URL: ${readString(params.fetchResult.finalUrl) || params.source.url}`,
    `Content type: ${readString(params.fetchResult.contentType) || "unknown"}`,
    `Extractor: ${readString(params.fetchResult.extractor) || "web_fetch"}`,
    `Fetched at: ${readString(params.fetchResult.fetchedAt) || "unknown"}`,
    "",
    params.extractedText || "No readable page text was extracted.",
  ].join("\n");
}

function slugPart(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^\w\s-]/gu, "")
      .trim()
      .toLowerCase()
      .replace(/[_\s-]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 60) || "source"
  );
}

function cleanSentence(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/^[\s"':;,.!?-]+/u, "")
    .replace(/[\s"']+$/u, "")
    .trim();
}

function sentenceLooksInstructional(value: string): boolean {
  const lower = value.toLowerCase();
  if (value.length < 55 || value.length > 280) {
    return false;
  }
  if (value.split(/\s+/u).length < 8) {
    return false;
  }
  return ![
    "cookie",
    "copyright",
    "javascript",
    "privacy policy",
    "sign in",
    "subscribe",
    "terms of use",
  ].some((term) => lower.includes(term));
}

function extractSemanticSentences(text: string): string[] {
  const normalized = normalizeFetchedText(text);
  const chunks = normalized
    .split(/(?<=[.!?])\s+|\n+/u)
    .map(cleanSentence)
    .filter(Boolean);
  const candidates = chunks.length > 0 ? chunks : [cleanSentence(normalized)];
  const unique = new Set<string>();
  for (const sentence of candidates) {
    if (sentenceLooksInstructional(sentence)) {
      unique.add(sentence);
    }
  }
  return [...unique].slice(0, 2);
}

function buildSemanticCrawledClaims(params: {
  records: readonly {
    source: CourseCreatorResearchPackSourceInput;
    extractedText: string;
  }[];
}): CourseCreatorResearchPackClaimInput[] {
  const claims: CourseCreatorResearchPackClaimInput[] = [];
  for (const record of params.records) {
    const sentences = extractSemanticSentences(record.extractedText);
    sentences.forEach((sentence, index) => {
      claims.push({
        id: `claim-semantic-${slugPart(record.source.id)}-${index + 1}`,
        lessonId: "lesson-01",
        text: sentence,
        sourceIds: [record.source.id],
        evidenceSpans: [
          {
            sourceId: record.source.id,
            excerpt: sentence,
          },
        ],
      });
    });
  }
  return claims;
}

export async function createCourseCreatorLiveCrawlPack(params: {
  topic: string;
  researchPack: CourseCreatorResearchPackInput;
  maxChars?: number;
  config?: OpenClawConfig;
  now?: Date;
  signal?: AbortSignal;
  runFetch?: CourseCreatorLiveCrawlRunner;
}): Promise<CourseCreatorLiveCrawlPackResult> {
  const crawledAt = (params.now ?? new Date()).toISOString();
  const maxChars = Math.max(500, Math.min(50_000, Math.floor(params.maxChars ?? 12_000)));
  const runFetch = params.runFetch ?? defaultLiveCrawlRunner;
  const fetchedRecords: Array<{
    source: CourseCreatorResearchPackSourceInput;
    extractedText: string;
  }> = [];
  const failures: CourseCreatorLiveCrawlReport["failures"] = [];

  for (const source of params.researchPack.sources) {
    try {
      const fetched = await runFetch({
        source,
        maxChars,
        config: params.config,
        signal: params.signal,
      });
      const extractedText = normalizeFetchedText(fetched.result.text);
      if (extractedText.length < 80) {
        throw new Error("web_fetch returned less than 80 characters of extracted source text.");
      }
      const content = buildCrawledSourceContent({
        source,
        fetchResult: fetched.result,
        extractedText,
      });
      fetchedRecords.push({
        source: {
          ...source,
          license: `${source.license}; live-page-extracted; semantic-claims-extracted`,
          content,
        },
        extractedText,
      });
    } catch (error) {
      failures.push({
        sourceId: source.id,
        url: source.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const fetchedSources = fetchedRecords.map((record) => record.source);
  if (fetchedSources.length < 2) {
    return {
      report: blockedReport({
        requested: params.researchPack.sources.length,
        fetched: fetchedSources.length,
        sourceIds: fetchedSources.map((source) => source.id),
        crawledAt,
        failures,
      }),
    };
  }

  const semanticClaims = buildSemanticCrawledClaims({
    records: fetchedRecords,
  });
  const semanticClaimSourceIds = [...new Set(semanticClaims.flatMap((claim) => claim.sourceIds))];
  if (semanticClaims.length < 2) {
    const sourcesWithClaims = new Set(semanticClaimSourceIds);
    return {
      report: blockedReport({
        requested: params.researchPack.sources.length,
        fetched: fetchedSources.length,
        sourceIds: fetchedSources.map((source) => source.id),
        semanticClaimsExtracted: semanticClaims.length,
        semanticClaimSourceIds,
        crawledAt,
        failures: [
          ...failures,
          ...fetchedSources
            .filter((source) => !sourcesWithClaims.has(source.id))
            .map((source) => ({
              sourceId: source.id,
              url: source.url,
              error: "No instructional factual sentence was extracted from the fetched page text.",
            })),
        ],
      }),
    };
  }

  const researchPack = {
    schemaVersion: 1,
    sources: fetchedSources,
    claims: semanticClaims,
  } satisfies CourseCreatorResearchPackInput;

  return {
    researchPack,
    report: {
      status: "pass",
      requested: params.researchPack.sources.length,
      fetched: fetchedSources.length,
      sourceIds: fetchedSources.map((source) => source.id),
      semanticClaimsExtracted: semanticClaims.length,
      semanticClaimSourceIds,
      crawledAt,
      failures,
      requiredHumanActions:
        failures.length > 0
          ? ["Review partial crawl failures before production course generation."]
          : ["Generate learner-facing lessons from semantic source-backed claims."],
    },
  };
}

export const __testing = {
  extractSemanticSentences,
  normalizeFetchedText,
};
