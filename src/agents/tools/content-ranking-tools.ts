import { Type } from "@sinclair/typebox";
import type { NewsArticle } from "../../content/news-aggregator/types.js";
import type { RankedArticle } from "../../content/ranking/types.js";
import { ArticleClusterer } from "../../content/ranking/clusterer.js";
import { ArticleRanker } from "../../content/ranking/ranker.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam } from "./common.js";

const ContentRankSchema = Type.Object({
  articles: Type.Array(Type.Any()), // NewsArticle[]
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  sourceAuthorityMap: Type.Optional(Type.Record(Type.String(), Type.Number())),
});

const ContentClusterSchema = Type.Object({
  articles: Type.Array(Type.Any()), // RankedArticle[]
  minClusterSize: Type.Optional(Type.Number({ minimum: 1 })),
});

const ContentTopSchema = Type.Object({
  articles: Type.Array(Type.Any()), // NewsArticle[]
  limit: Type.Number({ minimum: 1 }),
  sourceAuthorityMap: Type.Optional(Type.Record(Type.String(), Type.Number())),
});

export function createContentRankTool(): AnyAgentTool {
  return {
    label: "Content",
    name: "content_rank",
    description:
      "Rank articles by importance using multiple factors (recency, authority, semantic relevance, engagement, cross-references).",
    parameters: ContentRankSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const articlesRaw = params.articles;
      const limit = readNumberParam(params, "limit");
      const sourceAuthorityMap =
        typeof params.sourceAuthorityMap === "object" &&
        params.sourceAuthorityMap !== null &&
        !Array.isArray(params.sourceAuthorityMap)
          ? (params.sourceAuthorityMap as Record<string, number>)
          : undefined;

      if (!Array.isArray(articlesRaw)) {
        return jsonResult({
          status: "error",
          error: "articles array required",
        });
      }

      try {
        const articles = articlesRaw as NewsArticle[];
        const ranker = new ArticleRanker();
        const ranked = ranker.rankArticles(articles, sourceAuthorityMap);

        const result = limit ? ranked.slice(0, limit) : ranked;

        return jsonResult({
          status: "success",
          articles: result,
          count: result.length,
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

export function createContentClusterTool(): AnyAgentTool {
  return {
    label: "Content",
    name: "content_cluster",
    description:
      "Cluster related articles by semantic similarity. Groups articles with similar topics together.",
    parameters: ContentClusterSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const articlesRaw = params.articles;
      const minClusterSize = readNumberParam(params, "minClusterSize") || 2;

      if (!Array.isArray(articlesRaw)) {
        return jsonResult({
          status: "error",
          error: "articles array required",
        });
      }

      try {
        const articles = articlesRaw as RankedArticle[];
        const clusters = ArticleClusterer.clusterArticles(articles, minClusterSize);

        return jsonResult({
          status: "success",
          clusters,
          count: clusters.length,
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

export function createContentTopTool(): AnyAgentTool {
  return {
    label: "Content",
    name: "content_top",
    description:
      "Get top N articles ranked by importance. Returns the highest-scoring articles.",
    parameters: ContentTopSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const articlesRaw = params.articles;
      const limit = readNumberParam(params, "limit", { required: true });
      const sourceAuthorityMap =
        typeof params.sourceAuthorityMap === "object" &&
        params.sourceAuthorityMap !== null &&
        !Array.isArray(params.sourceAuthorityMap)
          ? (params.sourceAuthorityMap as Record<string, number>)
          : undefined;

      if (!Array.isArray(articlesRaw)) {
        return jsonResult({
          status: "error",
          error: "articles array required",
        });
      }

      if (!limit || limit < 1) {
        return jsonResult({
          status: "error",
          error: "limit must be at least 1",
        });
      }

      try {
        const articles = articlesRaw as NewsArticle[];
        const ranker = new ArticleRanker();
        const topArticles = ranker.getTopArticles(
          articles,
          limit,
          sourceAuthorityMap,
        );

        return jsonResult({
          status: "success",
          articles: topArticles,
          count: topArticles.length,
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
