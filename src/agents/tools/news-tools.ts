import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { NewsAggregator } from "../../content/news-aggregator/aggregator.js";
import type { NewsSource } from "../../content/news-aggregator/types.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

// Singleton instance for state persistence
let aggregatorInstance: NewsAggregator | null = null;

function getAggregator(): NewsAggregator {
  if (!aggregatorInstance) {
    aggregatorInstance = new NewsAggregator();
  }
  return aggregatorInstance;
}

const NewsAggregateSchema = Type.Object({
  action: optionalStringEnum(["start", "stop"] as const),
});

const NewsSourcesSchema = Type.Object({
  action: optionalStringEnum(["add", "remove", "list"] as const),
  source: Type.Optional(Type.Any()), // NewsSource
  sourceId: Type.Optional(Type.String()),
});

const NewsFetchSchema = Type.Object({
  sourceId: Type.Optional(Type.String()),
});

const NewsStatusSchema = Type.Object({});

export function createNewsAggregateTool(): AnyAgentTool {
  return {
    label: "News",
    name: "news_aggregate",
    description:
      "Start or stop news aggregation from RSS feeds. Aggregation fetches articles from configured sources.",
    parameters: NewsAggregateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action") || "start";
      const aggregator = getAggregator();

      try {
        if (action === "start") {
          await aggregator.start();
          return jsonResult({
            status: "started",
            message: "News aggregation started",
          });
        } else if (action === "stop") {
          aggregator.stop();
          return jsonResult({
            status: "stopped",
            message: "News aggregation stopped",
          });
        } else {
          return jsonResult({
            status: "error",
            error: `Unknown action: ${action}`,
          });
        }
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createNewsSourcesTool(): AnyAgentTool {
  return {
    label: "News",
    name: "news_sources",
    description:
      "Manage news sources (RSS feeds). Add, remove, or list sources for aggregation.",
    parameters: NewsSourcesSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const aggregator = getAggregator();

      try {
        if (action === "add") {
          const sourceRaw = params.source;
          if (!sourceRaw || typeof sourceRaw !== "object") {
            return jsonResult({
              status: "error",
              error: "source object required for add action",
            });
          }
          const source = sourceRaw as NewsSource;
          aggregator.addSource(source);
          return jsonResult({
            status: "success",
            message: `Source ${source.id} added`,
            source,
          });
        } else if (action === "remove") {
          const sourceId = readStringParam(params, "sourceId", { required: true });
          aggregator.removeSource(sourceId);
          return jsonResult({
            status: "success",
            message: `Source ${sourceId} removed`,
          });
        } else if (action === "list") {
          // Access sources via loadConfig since getConfig is private
          const config = loadConfig();
          const newsConfig = config.content?.newsAggregator;
          const sources = newsConfig?.sources || [];
          return jsonResult({
            status: "success",
            sources,
          });
        } else {
          return jsonResult({
            status: "error",
            error: `Unknown action: ${action}`,
          });
        }
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createNewsFetchTool(): AnyAgentTool {
  return {
    label: "News",
    name: "news_fetch",
    description:
      "Fetch articles from news aggregator. Returns all articles or articles from a specific source.",
    parameters: NewsFetchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sourceId = readStringParam(params, "sourceId");
      const aggregator = getAggregator();

      try {
        const articles = sourceId
          ? aggregator.getArticlesBySource(sourceId)
          : aggregator.getArticles();

        return jsonResult({
          status: "success",
          articles,
          count: articles.length,
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

export function createNewsStatusTool(): AnyAgentTool {
  return {
    label: "News",
    name: "news_status",
    description: "Get news aggregation status including last run time and errors.",
    parameters: NewsStatusSchema,
    execute: async (_toolCallId, _args) => {
      const aggregator = getAggregator();

      try {
        const status = aggregator.getStatus();
        return jsonResult({
          status: "success",
          ...status,
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
