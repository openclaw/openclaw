import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { getStructuredStore } from "../../memory/structured-store.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemoryStoreSchema = Type.Object({
  collection: Type.String(),
  key: Type.String(),
  value: Type.Unknown(),
});

const MemoryQuerySchema = Type.Object({
  collection: Type.String(),
  filter: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  limit: Type.Optional(Type.Number()),
});

const MemoryDeleteSchema = Type.Object({
  collection: Type.String(),
  key: Type.String(),
});

const MemoryCollectionsSchema = Type.Object({});

interface StructuredMemoryToolOptions {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}

function resolveAgentIdForStore(options: StructuredMemoryToolOptions): string {
  const cfg = options.config;
  if (!cfg) {
    return "default";
  }
  return resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
}

export function createMemoryStoreTool(options: StructuredMemoryToolOptions): AnyAgentTool | null {
  const agentId = resolveAgentIdForStore(options);
  return {
    label: "Memory Store",
    name: "memory_store",
    description:
      "Store or update a structured key-value entry in a named collection. " +
      "Use for persisting facts, preferences, entity data, or any structured information " +
      "that should survive across sessions. Value can be any JSON-serializable object.",
    parameters: MemoryStoreSchema,
    execute: async (_toolCallId, params) => {
      const collection = readStringParam(params, "collection", { required: true });
      const key = readStringParam(params, "key", { required: true });
      const value = (params as Record<string, unknown>).value;
      if (value === undefined) {
        return jsonResult({ ok: false, error: "value is required" });
      }
      try {
        const store = getStructuredStore(agentId);
        store.store(collection, key, value);
        return jsonResult({ ok: true, collection, key });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: message });
      }
    },
  };
}

export function createMemoryQueryTool(options: StructuredMemoryToolOptions): AnyAgentTool | null {
  const agentId = resolveAgentIdForStore(options);
  return {
    label: "Memory Query",
    name: "memory_query",
    description:
      "Query structured entries from a named collection. " +
      "Optionally filter by key-value pairs (exact match on top-level fields) " +
      "and limit the number of results.",
    parameters: MemoryQuerySchema,
    execute: async (_toolCallId, params) => {
      const collection = readStringParam(params, "collection", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const filter = (params as Record<string, unknown>).filter as
        | Record<string, unknown>
        | undefined;
      try {
        const store = getStructuredStore(agentId);
        const entries = store.query(collection, filter, limit ?? undefined);
        return jsonResult({ collection, count: entries.length, entries });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ collection, count: 0, entries: [], error: message });
      }
    },
  };
}

export function createMemoryDeleteTool(options: StructuredMemoryToolOptions): AnyAgentTool | null {
  const agentId = resolveAgentIdForStore(options);
  return {
    label: "Memory Delete",
    name: "memory_delete",
    description:
      "Delete a structured entry by collection and key. " +
      "Returns whether the entry existed and was deleted.",
    parameters: MemoryDeleteSchema,
    execute: async (_toolCallId, params) => {
      const collection = readStringParam(params, "collection", { required: true });
      const key = readStringParam(params, "key", { required: true });
      try {
        const store = getStructuredStore(agentId);
        const deleted = store.remove(collection, key);
        return jsonResult({ ok: true, deleted, collection, key });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: message });
      }
    },
  };
}

export function createMemoryCollectionsTool(
  options: StructuredMemoryToolOptions,
): AnyAgentTool | null {
  const agentId = resolveAgentIdForStore(options);
  return {
    label: "Memory Collections",
    name: "memory_collections",
    description:
      "List all structured memory collections and their entry counts. " +
      "Use to discover what structured data has been stored.",
    parameters: MemoryCollectionsSchema,
    execute: async (_toolCallId, _params) => {
      try {
        const store = getStructuredStore(agentId);
        const collections = store.collections();
        return jsonResult({ collections });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ collections: [], error: message });
      }
    },
  };
}
