import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Guard } from "typebox/guard";
import { readDispatchCall, readDispatchId } from "../../packages/agent-core/src/dispatch-call.js";
import {
  MAX_TOOL_SEARCH_BATCH_QUERIES,
  MAX_TOOL_SEARCH_BATCH_QUERY_BYTES,
  MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
  MAX_TOOL_SEARCH_RESULTS,
  type ToolSearchConfig,
  type ToolSearchRequest,
} from "./tool-search-protocol.js";
import type { ToolSearchCatalogSession } from "./tool-search-types.js";
import { asToolParamsRecord, ToolInputError } from "./tools/common.js";

export function readToolSearchId(args: unknown): string {
  const id = readDispatchId(args);
  if (id === undefined) {
    throw new ToolInputError("id must be a non-empty string.");
  }
  return id;
}

export function readToolSearchCallArgs(
  args: unknown,
  catalog?: ToolSearchCatalogSession,
): { id: string; input: unknown } {
  const call = readDispatchCall(
    args,
    catalog &&
      ((value) =>
        catalog.entries
          .filter((entry) => entry.id === value || entry.name === value)
          .map((entry) => entry.id)),
  );
  if ("error" in call) {
    throw new ToolInputError(call.error);
  }
  return call;
}

export function readToolSearchLimit(value: unknown, config: ToolSearchConfig): number {
  if (value === undefined) {
    return config.searchDefaultLimit;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolInputError("limit must be a positive integer.");
  }
  return Math.min(value, config.maxSearchLimit);
}

function readToolSearchArgs(
  params: Record<string, unknown>,
  query: string,
  config: ToolSearchConfig,
): { query: string; limit: number } {
  const options = isRecord(params.options) ? params.options : undefined;
  return {
    query,
    limit: readToolSearchLimit(params.limit ?? options?.limit, config),
  };
}

type BatchToolSearchEntry = { query: string; limit: number };

function readBatchToolSearchEntry(
  value: unknown,
  index: number,
  config: ToolSearchConfig,
): BatchToolSearchEntry {
  if (!isRecord(value)) {
    throw new ToolInputError(`queries[${index}] must be an object.`);
  }
  const rawQuery = value.query;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!query) {
    throw new ToolInputError(`queries[${index}].query must be a non-empty string.`);
  }
  if (!Guard.IsMaxLength(query, MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES)) {
    throw new ToolInputError(
      `queries[${index}].query must not exceed ${MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES} characters.`,
    );
  }
  try {
    return { query, limit: readToolSearchLimit(value.limit, config) };
  } catch (error) {
    if (error instanceof ToolInputError) {
      throw new ToolInputError(`queries[${index}].${error.message}`);
    }
    throw error;
  }
}

function readBatchToolSearchRequest(
  searches: BatchToolSearchEntry[],
  config: ToolSearchConfig,
): ToolSearchRequest {
  if (searches.length > MAX_TOOL_SEARCH_BATCH_QUERIES) {
    throw new ToolInputError(
      `queries may contain at most ${MAX_TOOL_SEARCH_BATCH_QUERIES} entries.`,
    );
  }
  const requestedResults = searches.reduce((total, search) => total + search.limit, 0);
  if (requestedResults > MAX_TOOL_SEARCH_RESULTS) {
    throw new ToolInputError(
      `batch queries resolve to ${requestedResults} results, but may request at most ${MAX_TOOL_SEARCH_RESULTS} in total. An omitted limit counts as ${config.searchDefaultLimit}; set smaller per-query limits and retry.`,
    );
  }
  const serializedQueries = JSON.stringify(searches.map((search) => search.query));
  const serializedQueryBytes = new TextEncoder().encode(serializedQueries).byteLength;
  if (serializedQueryBytes > MAX_TOOL_SEARCH_BATCH_QUERY_BYTES) {
    throw new ToolInputError(
      `serialized batch query text may use at most ${MAX_TOOL_SEARCH_BATCH_QUERY_BYTES} UTF-8 bytes.`,
    );
  }
  return { kind: "batch", searches };
}

/** Normalize scalar and batch shapes without dropping independent searches. */
export function readToolSearchRequest(args: unknown, config: ToolSearchConfig): ToolSearchRequest {
  const params = asToolParamsRecord(args);
  const query = params.query;
  const queries = params.queries;
  const hasQuery = query != null;
  const hasQueries = queries != null;
  if (!hasQuery && !hasQueries) {
    throw new ToolInputError("provide query or queries.");
  }
  if (queries != null && !Array.isArray(queries)) {
    throw new ToolInputError("queries must be a non-empty array.");
  }
  const batchEntries = queries ?? [];
  if (query != null && typeof query !== "string") {
    throw new ToolInputError("query must be a string.");
  }
  const singleQuery = query?.trim() ? query : undefined;
  if (batchEntries.length === 0) {
    if (query == null || (singleQuery === undefined && hasQueries)) {
      throw new ToolInputError("queries must be a non-empty array.");
    }
    return { kind: "single", search: readToolSearchArgs(params, query, config) };
  }
  if (singleQuery === undefined && (params.limit != null || params.options !== undefined)) {
    throw new ToolInputError("set limit on each batch query, not on the batch request.");
  }
  const searches = batchEntries.map((value, index) =>
    readBatchToolSearchEntry(value, index, config),
  );
  if (singleQuery !== undefined) {
    // Even identical text is an independent search with its own limit and budget.
    const single = readToolSearchArgs(params, singleQuery, config);
    searches.unshift({ query: single.query.trim(), limit: single.limit });
  }
  return readBatchToolSearchRequest(searches, config);
}
