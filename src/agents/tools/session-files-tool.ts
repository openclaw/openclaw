import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { CsvQueryFilter } from "../../sessions/files/types.js";
import type { AnyAgentTool } from "./common.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import { buildAgentMainSessionKey, DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { queryCsv } from "../../sessions/files/csv-query.js";
import { searchText } from "../../sessions/files/pdf-search.js";
import { listFiles, getFile, getParsedCsv, deleteFile } from "../../sessions/files/storage.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

function resolveSessionIdFromKey(params: {
  sessionKey?: string;
  cfg: OpenClawConfig;
  agentId: string;
}): string | null {
  const { sessionKey, cfg, agentId } = params;
  if (!sessionKey) {
    return null;
  }

  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);

  const internal = resolveInternalSessionKey({
    key: sessionKey,
    alias,
    mainKey,
  });

  const candidates = new Set<string>([sessionKey, internal]);
  if (!sessionKey.startsWith("agent:")) {
    candidates.add(`agent:${DEFAULT_AGENT_ID}:${sessionKey}`);
    candidates.add(`agent:${DEFAULT_AGENT_ID}:${internal}`);
  }
  if (sessionKey === "main") {
    candidates.add(
      buildAgentMainSessionKey({
        agentId: DEFAULT_AGENT_ID,
        mainKey,
      }),
    );
  }

  for (const key of candidates) {
    const entry = store[key];
    if (entry?.sessionId) {
      return entry.sessionId;
    }
  }

  return null;
}

const SessionFilesListSchema = Type.Object({
  sessionId: Type.Optional(
    Type.String({
      description: "Session ID to list files for (optional, uses current session if not provided)",
    }),
  ),
});

const SessionFilesGetSchema = Type.Object({
  sessionId: Type.Optional(
    Type.String({
      description: "Session ID to get file from (optional, uses current session if not provided)",
    }),
  ),
  fileId: Type.String({ description: "File ID to retrieve" }),
});

const SessionFilesQueryCsvSchema = Type.Object({
  sessionId: Type.Optional(
    Type.String({
      description: "Session ID to query CSV from (optional, uses current session if not provided)",
    }),
  ),
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
  sessionId: Type.Optional(
    Type.String({
      description: "Session ID to search files in (optional, uses current session if not provided)",
    }),
  ),
  fileId: Type.String({ description: "File ID to search" }),
  query: Type.String({ description: "Search query (space-separated tokens)" }),
  maxResults: Type.Optional(Type.Number({ description: "Maximum number of matches to return" })),
});

const SessionFilesDeleteSchema = Type.Object({
  sessionId: Type.Optional(
    Type.String({
      description:
        "Session ID to delete file from (optional, uses current session if not provided)",
    }),
  ),
  fileId: Type.String({ description: "File ID to delete" }),
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
    description:
      "List all files stored for a session. Note: All files are stored with .md file extension, but content remains in original format (CSV files contain raw CSV, JSON files contain raw JSON, PDF files contain extracted text, text files contain raw text). The 'type' field indicates the original content type.",
    parameters: SessionFilesListSchema,
    execute: async (_toolCallId, params) => {
      let sessionId = readStringParam(params, "sessionId");
      if (!sessionId) {
        sessionId =
          resolveSessionIdFromKey({
            sessionKey: options.agentSessionKey,
            cfg,
            agentId,
          }) ?? undefined;
      }
      if (!sessionId) {
        return jsonResult({
          files: [],
          error:
            "sessionId is required. Provide sessionId parameter or ensure agentSessionKey is set.",
        });
      }
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
    description:
      "Get file content and metadata by file ID. Note: All files are stored with .md file extension, but content is returned in original format (raw CSV, raw JSON, extracted PDF text, raw text). The 'type' field in metadata indicates the original content type.",
    parameters: SessionFilesGetSchema,
    execute: async (_toolCallId, params) => {
      let sessionId = readStringParam(params, "sessionId");
      if (!sessionId) {
        sessionId =
          resolveSessionIdFromKey({
            sessionKey: options.agentSessionKey,
            cfg,
            agentId,
          }) ?? undefined;
      }
      if (!sessionId) {
        return jsonResult({
          content: null,
          error:
            "sessionId is required. Provide sessionId parameter or ensure agentSessionKey is set.",
        });
      }
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
      let sessionId = readStringParam(params, "sessionId");
      if (!sessionId) {
        sessionId =
          resolveSessionIdFromKey({
            sessionKey: options.agentSessionKey,
            cfg,
            agentId,
          }) ?? undefined;
      }
      if (!sessionId) {
        return jsonResult({
          rows: [],
          total: 0,
          columns: [],
          error:
            "sessionId is required. Provide sessionId parameter or ensure agentSessionKey is set.",
        });
      }
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
            ? selectColumnsRaw
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
      let sessionId = readStringParam(params, "sessionId");
      if (!sessionId) {
        sessionId =
          resolveSessionIdFromKey({
            sessionKey: options.agentSessionKey,
            cfg,
            agentId,
          }) ?? undefined;
      }
      if (!sessionId) {
        return jsonResult({
          matches: [],
          error:
            "sessionId is required. Provide sessionId parameter or ensure agentSessionKey is set.",
        });
      }
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

export function createSessionFilesDeleteTool(options: {
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
    label: "Session Files Delete",
    name: "session_files_delete",
    description: "Delete a file from session storage by file ID",
    parameters: SessionFilesDeleteSchema,
    execute: async (_toolCallId, params) => {
      let sessionId = readStringParam(params, "sessionId");
      if (!sessionId) {
        sessionId =
          resolveSessionIdFromKey({
            sessionKey: options.agentSessionKey,
            cfg,
            agentId,
          }) ?? undefined;
      }
      if (!sessionId) {
        return jsonResult({
          deleted: false,
          error:
            "sessionId is required. Provide sessionId parameter or ensure agentSessionKey is set.",
        });
      }
      const fileId = readStringParam(params, "fileId", { required: true });
      try {
        await deleteFile({ sessionId, agentId, fileId });
        return jsonResult({ deleted: true, fileId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ deleted: false, error: message });
      }
    },
  };
}
