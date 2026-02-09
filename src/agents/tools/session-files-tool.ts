import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { CsvQueryFilter } from "../../sessions/files/types.js";
import type { AnyAgentTool } from "./common.js";
import { queryCsv } from "../../sessions/files/csv-query.js";
import { searchText } from "../../sessions/files/pdf-search.js";
import { listFiles, getFile, getParsedCsv } from "../../sessions/files/storage.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";

const SessionFilesListSchema = Type.Object({
  sessionId: Type.String({ description: "Session ID to list files for" }),
});

const SessionFilesGetSchema = Type.Object({
  sessionId: Type.String({ description: "Session ID to get file from" }),
  fileId: Type.String({ description: "File ID to retrieve" }),
});

const SessionFilesQueryCsvSchema = Type.Object({
  sessionId: Type.String({ description: "Session ID to query CSV from" }),
  fileId: Type.String({ description: "CSV file ID to query" }),
  filterColumn: Type.Optional(Type.String({ description: "Column name to filter on" })),
  filterOperator: Type.Optional(
    Type.Union([
      Type.Literal("eq"),
      Type.Literal("gt"),
      Type.Literal("lt"),
      Type.Literal("gte"),
      Type.Literal("lte"),
      Type.Literal("contains"),
      Type.Literal("startsWith"),
      Type.Literal("endsWith"),
    ]),
  ),
  filterValue: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  limit: Type.Optional(Type.Number({ description: "Maximum number of rows to return" })),
  selectColumns: Type.Optional(
    Type.Array(Type.String(), { description: "Columns to include in results" }),
  ),
});

const SessionFilesSearchSchema = Type.Object({
  sessionId: Type.String({ description: "Session ID to search files in" }),
  fileId: Type.String({ description: "File ID to search" }),
  query: Type.String({ description: "Search query (space-separated tokens)" }),
  maxResults: Type.Optional(Type.Number({ description: "Maximum number of matches to return" })),
});

export function createSessionFilesListTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  return {
    label: "Session Files List",
    name: "session_files_list",
    description: "List all files stored for a session",
    parameters: SessionFilesListSchema,
    execute: async (_toolCallId, params) => {
      const sessionId = readStringParam(params, "sessionId", { required: true });
      try {
        const files = await listFiles({ sessionId, agentId });
        return jsonResult({ files });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ files: [], error: message });
      }
    },
  };
}

export function createSessionFilesGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  return {
    label: "Session Files Get",
    name: "session_files_get",
    description: "Get file content and metadata by file ID",
    parameters: SessionFilesGetSchema,
    execute: async (_toolCallId, params) => {
      const sessionId = readStringParam(params, "sessionId", { required: true });
      const fileId = readStringParam(params, "fileId", { required: true });
      try {
        const { buffer, metadata } = await getFile({ sessionId, agentId, fileId });
        const content = buffer.toString("utf-8");
        return jsonResult({ content, metadata });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ content: null, error: message });
      }
    },
  };
}

export function createSessionFilesQueryCsvTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  return {
    label: "Session Files Query CSV",
    name: "session_files_query_csv",
    description:
      "Query CSV files with filters. Supports filtering by column values, limiting results, and selecting specific columns.",
    parameters: SessionFilesQueryCsvSchema,
    execute: async (_toolCallId, params) => {
      const sessionId = readStringParam(params, "sessionId", { required: true });
      const fileId = readStringParam(params, "fileId", { required: true });
      const filterColumn = readStringParam(params, "filterColumn");
      const filterOperator = readStringParam(params, "filterOperator") as
        | CsvQueryFilter["operator"]
        | undefined;
      const filterValueRaw = params.filterValue;
      const limit = readNumberParam(params, "limit");
      const selectColumnsRaw = params.selectColumns;

      try {
        const parsed = await getParsedCsv({ sessionId, agentId, fileId });
        let filter: CsvQueryFilter | undefined;
        if (filterColumn && filterOperator && filterValueRaw !== undefined) {
          filter = {
            column: filterColumn,
            operator: filterOperator,
            value: typeof filterValueRaw === "number" ? filterValueRaw : filterValueRaw,
          };
        }
        const selectColumns =
          Array.isArray(selectColumnsRaw) && selectColumnsRaw.every((c) => typeof c === "string")
            ? (selectColumnsRaw as string[])
            : undefined;

        const result = queryCsv({
          rows: parsed.rows,
          columns: parsed.columns,
          filter,
          limit,
          selectColumns,
        });
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ rows: [], total: 0, columns: [], error: message });
      }
    },
  };
}

export function createSessionFilesSearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  return {
    label: "Session Files Search",
    name: "session_files_search",
    description:
      "Search text content in PDF or text files. Returns matching lines with context. Query uses space-separated tokens (all must match).",
    parameters: SessionFilesSearchSchema,
    execute: async (_toolCallId, params) => {
      const sessionId = readStringParam(params, "sessionId", { required: true });
      const fileId = readStringParam(params, "fileId", { required: true });
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");

      try {
        const { buffer, metadata } = await getFile({ sessionId, agentId, fileId });
        if (metadata.type !== "pdf" && metadata.type !== "text") {
          return jsonResult({
            matches: [],
            error: `File type ${metadata.type} is not searchable. Use session_files_query_csv for CSV files.`,
          });
        }
        const content = buffer.toString("utf-8");
        const matches = searchText(content, query, { maxResults });
        return jsonResult({ matches, fileId, filename: metadata.filename });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ matches: [], error: message });
      }
    },
  };
}
