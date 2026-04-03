/**
 * Context Tools - Context compression tools
 *
 * Provides tools for LLM to proactively compress and archive context
 */

import { Type } from "@sinclair/typebox";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { ContextArchive, createContextArchive } from "../../context-engine/archive.js";

// Simple helper - reconstruct on demand instead of caching
function getArchive(sessionId: string): ContextArchive {
  return createContextArchive(sessionId);
}

const importanceEnum = ["high", "medium", "low"] as const;
const recallModeEnum = ["summary", "full", "key_points"] as const;

/**
 * Create compress_context tool
 */
export function createCompressContextTool(sessionId: string): AnyAgentTool {
  return {
    name: "compress_context",
    description: `Compress and archive a range of messages from the current context.

Use this tool when:
- The topic has clearly shifted (e.g., from coding to writing)
- User explicitly wants to start a new task
- Context is approaching token limits

This tool will:
1. Archive the specified message range with a summary
2. Save to ~/.openclaw/archives/ directory
3. Return the archive path and tokens saved

You should provide a meaningful summary that captures:
- Main discussion points
- Key decisions made
- Important context for future reference`,
    parameters: Type.Object(
      {
        topic: Type.String({
          description: 'A brief title for the archived topic, e.g., "React component optimization discussion"',
        }),
        summary: Type.String({
          description: "Structured summary in Markdown format. Include main points, context, and outcomes.",
        }),
        key_decisions: Type.Optional(
          Type.Array(Type.String(), {
            description: "List of key decisions or conclusions from this discussion",
          }),
        ),
        message_range: Type.Object(
          {
            start: Type.Integer({ description: "Start index of messages to archive (0-based)" }),
            end: Type.Integer({ description: "End index of messages to archive (inclusive)" }),
          },
          { description: "Range of messages to archive" },
        ),
        importance: Type.Optional(
          Type.Union(importanceEnum.map((v) => Type.Literal(v)), {
            description: "Importance level. High importance archives are kept longer.",
          }),
        ),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const topic = readStringParam(params, "topic", { required: true });
      const summary = readStringParam(params, "summary", { required: true });
      const importance = (params.importance as "high" | "medium" | "low") ?? "medium";
      const keyDecisions = params.key_decisions as string[] | undefined;
      const messageRange = params.message_range as { start: number; end: number };

      const archive = getArchive(sessionId);
      const result = await archive.archive({
        topic,
        summary,
        key_decisions: keyDecisions,
        message_range: messageRange,
        importance,
      });

      return jsonResult({
        archive_id: result.archive_id,
        archive_path: result.archive_path,
        tokens_saved: result.tokens_saved,
        message: result.message,
      });
    },
  };
}

/**
 * Create list_archives tool
 */
export function createListArchivesTool(sessionId: string): AnyAgentTool {
  return {
    name: "list_archives",
    description: `List archived contexts from previous compressions.

Use this tool to find and recall archived conversations.

You can filter by:
- Date (YYYY-MM-DD format)
- Topic keyword

Returns a list of archives with their paths, topics, and token counts.`,
    parameters: Type.Object(
      {
        date: Type.Optional(Type.String({ description: "Filter by date (YYYY-MM-DD format)" })),
        topic_keyword: Type.Optional(Type.String({ description: "Filter by topic keyword" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const date = readStringParam(params, "date");
      const topicKeyword = readStringParam(params, "topic_keyword");
      const limit = (params.limit as number) ?? 10;

      const archive = getArchive(sessionId);
      const result = await archive.list({
        date,
        topic_keyword: topicKeyword,
        limit,
      });

      return jsonResult({
        archives: result.archives,
        total_count: result.total_count,
      });
    },
  };
}

/**
 * Create recall_archive tool
 */
export function createRecallArchiveTool(sessionId: string): AnyAgentTool {
  return {
    name: "recall_archive",
    description: `Recall and restore content from an archived context.

Modes:
- \`summary\`: Return just the summary (recommended)
- \`key_points\`: Return only key decisions
- \`full\`: Return complete archived content

Use this when you need to reference previous discussions that were archived.`,
    parameters: Type.Object(
      {
        archive_path: Type.String({
          description: "Path to the archive file (from list_archives)",
        }),
        mode: Type.Optional(
          Type.Union(recallModeEnum.map((v) => Type.Literal(v)), {
            description: "How much content to restore",
          }),
        ),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const archivePath = readStringParam(params, "archive_path", { required: true });
      const mode = (params.mode as "summary" | "full" | "key_points") ?? "summary";

      const archive = getArchive(sessionId);
      const result = await archive.recall(archivePath, mode);

      return jsonResult({
        content: result.content,
        tokens_added: result.tokens_added,
      });
    },
  };
}

/**
 * Create all context tools for a session
 */
export function createContextTools(sessionId: string): AnyAgentTool[] {
  return [
    createCompressContextTool(sessionId),
    createListArchivesTool(sessionId),
    createRecallArchiveTool(sessionId),
  ];
}

export default createContextTools;