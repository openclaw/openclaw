import { Type } from "@sinclair/typebox";
import type { RankedArticle } from "../../content/ranking/types.js";
import { CrossLinker } from "../../content/seo/crosslinker.js";
import { GEOTracker } from "../../content/seo/geo-tracker.js";
import { SEOOptimizer } from "../../content/seo/optimizer.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const SEOCrosslinkSchema = Type.Object({
  articles: Type.Array(Type.Any()), // RankedArticle[]
  maxLinksPerArticle: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
  minRelevanceScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

const GEOCheckRankingSchema = Type.Object({
  articles: Type.Array(Type.Any()), // RankedArticle[]
  queries: Type.Optional(Type.Array(Type.String())),
  engines: Type.Optional(Type.Array(Type.String())),
});

const SEOOptimizeSchema = Type.Object({
  articles: Type.Array(Type.Any()), // RankedArticle[]
});

export function createSEOCrosslinkTool(): AnyAgentTool {
  return {
    label: "SEO",
    name: "seo_crosslink",
    description:
      "Generate cross-links between related articles for SEO. Creates links based on semantic similarity and keyword overlap.",
    parameters: SEOCrosslinkSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const articlesRaw = params.articles;
      const maxLinksPerArticle =
        readNumberParam(params, "maxLinksPerArticle") || 5;
      const minRelevanceScore =
        readNumberParam(params, "minRelevanceScore") || 0.3;

      if (!Array.isArray(articlesRaw)) {
        return jsonResult({
          status: "error",
          error: "articles array required",
        });
      }

      try {
        const articles = articlesRaw as RankedArticle[];
        const crossLinks = CrossLinker.generateCrossLinks(
          articles,
          maxLinksPerArticle,
          minRelevanceScore,
        );

        return jsonResult({
          status: "success",
          crossLinks,
          count: crossLinks.length,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createGEOCheckRankingTool(): AnyAgentTool {
  return {
    label: "SEO",
    name: "geo_check_ranking",
    description:
      "Check how articles rank in AI search engines (ChatGPT, Grok, Claude, Perplexity). Tracks Generative Engine Optimization (GEO) rankings.",
    parameters: GEOCheckRankingSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const articlesRaw = params.articles;
      const queriesRaw = params.queries;
      const enginesRaw = params.engines;

      if (!Array.isArray(articlesRaw)) {
        return jsonResult({
          status: "error",
          error: "articles array required",
        });
      }

      const articles = articlesRaw as RankedArticle[];
      const queries = Array.isArray(queriesRaw)
        ? queriesRaw.filter((q) => typeof q === "string")
        : undefined;
      const engines = Array.isArray(enginesRaw)
        ? enginesRaw.filter((e) => typeof e === "string")
        : ["chatgpt", "grok", "claude", "perplexity"];

      try {
        const rankings = await GEOTracker.checkRankings(
          articles,
          queries || [],
          engines,
        );

        return jsonResult({
          status: "success",
          rankings,
          count: rankings.length,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createSEOOptimizeTool(): AnyAgentTool {
  return {
    label: "SEO",
    name: "seo_optimize",
    description:
      "Get SEO/GEO optimization suggestions for articles. Analyzes titles, descriptions, keywords, and cross-linking opportunities.",
    parameters: SEOOptimizeSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const articlesRaw = params.articles;

      if (!Array.isArray(articlesRaw)) {
        return jsonResult({
          status: "error",
          error: "articles array required",
        });
      }

      try {
        const articles = articlesRaw as RankedArticle[];
        const suggestions = SEOOptimizer.analyze(articles);
        const report = SEOOptimizer.generateReport(articles);

        return jsonResult({
          status: "success",
          suggestions,
          report,
          count: suggestions.length,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
