import { useCallback } from "react";
import type {
  MemorySearchResultUI,
  MemoryProviderStatusUI,
  ActivityEntry,
} from "@/store/memory-store";
import { useMemoryStore } from "@/store/memory-store";
import type { AgentFilesListResult, AgentFileGetResult, AgentFileSetResult } from "@/types/agents";
import { useGateway } from "./use-gateway";

/**
 * Returns true for errors that indicate the gateway connection is being torn
 * down (React StrictMode double-mount, page navigation, etc.). These are not
 * real failures — the operation simply never got a chance to run — and should
 * be swallowed rather than re-thrown as unhandled rejections.
 */
function isGatewayTeardownError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.message === "gateway client stopped" ||
    err.message === "gateway not connected" ||
    err.message.startsWith("gateway closed")
  );
}

type MemoryStatusResult = {
  agentId: string;
  status: MemoryProviderStatusUI | null;
  embedding: { ok: boolean; error?: string };
  healthy: boolean;
  healthScore?: {
    score: number;
    grade: "A" | "B" | "C" | "D" | "F";
    factors: {
      indexContent: number;
      embedding: number;
      memoryMdRecency: number;
      dailyNoteActivity: number;
      noFallback: number;
    };
    issues: string[];
  };
};

type MemorySearchResult = {
  results: MemorySearchResultUI[];
  provider: string;
  backend: string;
  model?: string;
  files?: number;
  fallbackSearch?: boolean;
};

type MemoryReindexResult = {
  ok: boolean;
  error?: string;
};

type MemoryActivityResult = {
  entries: Array<{
    timestamp: number;
    operation: "search" | "read" | "write" | "edit";
    toolName: string;
    filePath?: string;
    query?: string;
    snippet?: string;
    sessionFile: string;
  }>;
  sessionsScanned: number;
};

let activityIdCounter = 0;

export function useMemory() {
  const { sendRpc } = useGateway();

  const getMemoryStatus = useCallback(async () => {
    const store = useMemoryStore.getState();
    store.setIndexLoading(true);
    try {
      const result = await sendRpc<MemoryStatusResult>("memory.status");
      store.setAgentId(result.agentId);
      store.setIndexStatus(result.status);
      store.setEmbeddingOk(result.embedding.ok);
      store.setEmbeddingError(result.embedding.error ?? null);
      store.setHealthy(result.healthy);
      store.setHealthScore(result.healthScore ?? null);
      return result;
    } catch (err) {
      if (!isGatewayTeardownError(err)) {
        console.error("[memory] failed to get status:", err);
        throw err;
      }
    } finally {
      store.setIndexLoading(false);
    }
  }, [sendRpc]);

  const searchMemory = useCallback(
    async (query: string, opts?: { maxResults?: number; minScore?: number }) => {
      const store = useMemoryStore.getState();
      store.setSearching(true);
      try {
        const result = await sendRpc<MemorySearchResult>("memory.search", {
          query,
          ...opts,
        });
        store.setSearchResults(result.results);
        store.setSearchBackend(result.backend);
        store.setSearchFiles(result.files ?? null);
        store.setSearchFallback(result.fallbackSearch ?? false);
        store.addToSearchHistory(query);
        return result;
      } catch (err) {
        if (!isGatewayTeardownError(err)) {
          console.error("[memory] search failed:", err);
          throw err;
        }
      } finally {
        store.setSearching(false);
      }
    },
    [sendRpc],
  );

  const reindexMemory = useCallback(async () => {
    const store = useMemoryStore.getState();
    store.setReindexing(true);
    try {
      const result = await sendRpc<MemoryReindexResult>("memory.reindex");
      if (!result.ok) {
        console.error("[memory] reindex failed:", result.error);
      }
      return result;
    } catch (err) {
      if (!isGatewayTeardownError(err)) {
        console.error("[memory] reindex failed:", err);
        throw err;
      }
    } finally {
      store.setReindexing(false);
    }
  }, [sendRpc]);

  const listMemoryFiles = useCallback(
    async (agentId: string) => {
      const store = useMemoryStore.getState();
      store.setFilesLoading(true);
      try {
        const result = await sendRpc<AgentFilesListResult>("agents.files.list", { agentId });
        const files = (result.files ?? []).map((f) => ({
          name: f.name,
          path: f.path,
          missing: f.missing,
          size: f.size,
          updatedAtMs: f.updatedAtMs,
        }));
        store.setFiles(files);
        return result;
      } catch (err) {
        if (!isGatewayTeardownError(err)) {
          console.error("[memory] failed to list files:", err);
          throw err;
        }
      } finally {
        store.setFilesLoading(false);
      }
    },
    [sendRpc],
  );

  const getMemoryFile = useCallback(
    async (agentId: string, name: string) => {
      const store = useMemoryStore.getState();
      store.setFileLoading(true);
      try {
        const result = await sendRpc<AgentFileGetResult>("agents.files.get", { agentId, name });
        const content = result.file?.content ?? "";
        store.setFileContent(content);
        store.setOriginalFileContent(content);
        return result;
      } catch (err) {
        if (!isGatewayTeardownError(err)) {
          console.error("[memory] failed to get file:", err);
          throw err;
        }
      } finally {
        store.setFileLoading(false);
      }
    },
    [sendRpc],
  );

  const setMemoryFile = useCallback(
    async (agentId: string, name: string, content: string) => {
      const store = useMemoryStore.getState();
      store.setFileSaving(true);
      try {
        const result = await sendRpc<AgentFileSetResult>("agents.files.set", {
          agentId,
          name,
          content,
        });
        if (result.ok) {
          store.setOriginalFileContent(content);
        }
        return result;
      } catch (err) {
        if (!isGatewayTeardownError(err)) {
          console.error("[memory] failed to save file:", err);
          throw err;
        }
      } finally {
        store.setFileSaving(false);
      }
    },
    [sendRpc],
  );

  const loadActivityLog = useCallback(async () => {
    const store = useMemoryStore.getState();
    store.setActivityLoading(true);
    try {
      // Use the dedicated server-side RPC that scans raw JSONL files directly,
      // bypassing chat.history's message count and byte-size limits.
      const result = await sendRpc<MemoryActivityResult>("memory.activity");
      const allEntries: ActivityEntry[] = (result.entries ?? []).map((e) => ({
        id: `activity-${++activityIdCounter}`,
        timestamp: e.timestamp,
        operation: e.operation,
        toolName: e.toolName,
        filePath: e.filePath,
        query: e.query,
        snippet: e.snippet,
        sessionKey: e.sessionFile,
      }));
      store.setActivityLog(allEntries);
      store.setActivitySessionsScanned(result.sessionsScanned);
      store.setActivityHasMore(false);
    } catch (err) {
      if (!isGatewayTeardownError(err)) {
        console.error("[memory] failed to load activity:", err);
      }
    } finally {
      store.setActivityLoading(false);
    }
  }, [sendRpc]);

  const deleteMemoryFile = useCallback(
    async (agentId: string, name: string) => {
      try {
        const result = await sendRpc<{ ok: boolean; deleted: string }>("agents.files.delete", {
          agentId,
          name,
        });
        if (result.ok) {
          const store = useMemoryStore.getState();
          store.setFiles(store.files.filter((f) => f.path !== name && f.name !== name));
          store.setSelectedFile(null);
          store.setFileContent("");
          store.setOriginalFileContent("");
        }
        return result;
      } catch (err) {
        if (!isGatewayTeardownError(err)) {
          console.error("[memory] failed to delete file:", err);
          throw err;
        }
      }
    },
    [sendRpc],
  );

  const createMemoryFile = useCallback(
    async (agentId: string, name: string, content = "") => {
      try {
        const result = await sendRpc<{ ok: boolean; file: { name: string; path: string } }>(
          "agents.files.create",
          { agentId, name, content },
        );
        return result;
      } catch (err) {
        if (!isGatewayTeardownError(err)) {
          console.error("[memory] failed to create file:", err);
          throw err;
        }
      }
    },
    [sendRpc],
  );

  const embedMemory = useCallback(async () => {
    const store = useMemoryStore.getState();
    store.setEmbedding(true);
    try {
      const result = await sendRpc<MemoryReindexResult>("memory.embed");
      if (!result.ok) {
        console.error("[memory] embed failed:", result.error);
      }
      return result;
    } catch (err) {
      if (!isGatewayTeardownError(err)) {
        console.error("[memory] embed failed:", err);
        throw err;
      }
    } finally {
      store.setEmbedding(false);
    }
  }, [sendRpc]);

  return {
    getMemoryStatus,
    searchMemory,
    reindexMemory,
    embedMemory,
    listMemoryFiles,
    getMemoryFile,
    setMemoryFile,
    deleteMemoryFile,
    createMemoryFile,
    loadActivityLog,
  };
}
