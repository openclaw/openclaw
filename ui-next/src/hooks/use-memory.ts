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

type SessionEntry = {
  key: string;
  sessionId?: string;
  updatedAt?: number | null;
  [key: string]: unknown;
};

type SessionsListResult = {
  sessions: SessionEntry[];
};

type ChatHistoryResult = {
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
    timestamp?: number;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
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

  const loadActivityLog = useCallback(
    async (sessionLimit = 5, append = false) => {
      const store = useMemoryStore.getState();
      store.setActivityLoading(true);
      try {
        // Fetch a large pool so Load More can reach older sessions.
        const sessionsResult = await sendRpc<SessionsListResult>("sessions.list", {
          limit: Math.max(sessionLimit * 4, 200),
        });
        const allSessions = (sessionsResult.sessions ?? [])
          .slice()
          .toSorted((a, b) => ((b.updatedAt as number) ?? 0) - ((a.updatedAt as number) ?? 0));

        // Scan sessions in batches. When appending, auto-advance through batches
        // that yield no results so "Load more" always shows new entries or exhausts.
        const LOAD_BATCH = 10;
        let currentLimit = sessionLimit;
        let entries: ActivityEntry[] = [];

        // Allow up to 5 auto-advance rounds when appending yields nothing
        const maxRounds = append ? 5 : 1;
        for (let round = 0; round < maxRounds; round++) {
          const sessions =
            append && round === 0
              ? allSessions.slice(Math.max(0, currentLimit - LOAD_BATCH), currentLimit)
              : round > 0
                ? allSessions.slice(Math.max(0, currentLimit - LOAD_BATCH), currentLimit)
                : allSessions.slice(0, currentLimit);

          entries = [];

          for (const session of sessions) {
            try {
              const history = await sendRpc<ChatHistoryResult>("chat.history", {
                sessionKey: session.key,
                limit: 200,
              });

              for (const msg of history.messages ?? []) {
                // Strategy 1: assistant messages with toolCall content blocks
                if (msg.role === "assistant" && Array.isArray(msg.content)) {
                  for (const block of msg.content) {
                    if (block.type !== "toolCall" && block.type !== "tool_use") {
                      continue;
                    }
                    const toolName = (block.name ?? "") as string;
                    const toolInput = (block.arguments ?? block.input) as
                      | Record<string, unknown>
                      | undefined;

                    if (!isMemoryToolCall(toolName, toolInput)) {
                      continue;
                    }

                    entries.push({
                      id: `activity-${++activityIdCounter}`,
                      timestamp: msg.timestamp ?? 0,
                      operation: getOperation(toolName, toolInput),
                      toolName,
                      filePath: getFilePath(toolName, toolInput),
                      query: toolInput?.query as string | undefined,
                      snippet: getToolUseSnippet(toolName, toolInput),
                      sessionKey: session.key,
                    });
                  }
                }

                // Strategy 2: toolResult messages with top-level toolName
                if (
                  msg.role === "toolResult" &&
                  typeof (msg as Record<string, unknown>).toolName === "string"
                ) {
                  const toolName = (msg as Record<string, unknown>).toolName as string;
                  if (!isMemoryToolCall(toolName, undefined)) {
                    continue;
                  }

                  entries.push({
                    id: `activity-${++activityIdCounter}`,
                    timestamp: msg.timestamp ?? 0,
                    operation: getOperation(toolName, undefined),
                    toolName,
                    filePath: undefined,
                    query: undefined,
                    snippet: getToolResultSnippet(msg.content),
                    sessionKey: session.key,
                  });
                }
              }
            } catch {
              // Skip sessions that fail to load
            }
          }

          // If we found entries or exhausted all sessions, stop advancing
          if (entries.length > 0 || currentLimit >= allSessions.length) {
            break;
          }
          // Auto-advance to next batch
          currentLimit += LOAD_BATCH;
        }

        // Merge with existing entries when appending, then re-sort
        const merged = append ? [...store.activityLog, ...entries] : entries;
        merged.sort((a, b) => b.timestamp - a.timestamp);
        store.setActivityLog(merged);

        // Track how far we've scanned and whether more sessions remain
        store.setActivitySessionsScanned(currentLimit);
        store.setActivityHasMore(currentLimit < allSessions.length);
      } catch (err) {
        if (!isGatewayTeardownError(err)) {
          console.error("[memory] failed to load activity:", err);
        }
      } finally {
        store.setActivityLoading(false);
      }
    },
    [sendRpc],
  );

  return {
    getMemoryStatus,
    searchMemory,
    reindexMemory,
    listMemoryFiles,
    getMemoryFile,
    setMemoryFile,
    loadActivityLog,
  };
}

function isMemoryToolCall(toolName: string, toolInput?: Record<string, unknown>): boolean {
  if (toolName === "memory_search" || toolName === "memory_get" || toolName === "memory_read") {
    return true;
  }
  if (toolName === "write" && isMemoryPath(toolInput?.path as string)) {
    return true;
  }
  if (toolName === "edit" && isMemoryPath(toolInput?.file_path as string)) {
    return true;
  }
  if (toolName === "read" && isMemoryPath(toolInput?.file_path as string)) {
    return true;
  }
  return false;
}

function getToolResultSnippet(
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>,
): string | undefined {
  const text = typeof content === "string" ? content : content?.find((b) => b.text)?.text;
  if (!text) {
    return undefined;
  }
  // Try to parse JSON results for a cleaner snippet
  try {
    const parsed = JSON.parse(text);
    if (parsed?.results?.length) {
      return `${parsed.results.length} result(s) found`;
    }
  } catch {
    // Not JSON, use raw text
  }
  return text.length > 120 ? text.slice(0, 120) + "..." : text;
}

function isMemoryPath(path?: string): boolean {
  if (!path) {
    return false;
  }
  const lower = path.toLowerCase();
  return lower.includes("memory") || lower.includes("MEMORY");
}

function getOperation(
  toolName: string,
  toolInput?: Record<string, unknown>,
): ActivityEntry["operation"] {
  if (toolName === "memory_search") {
    return "search";
  }
  if (toolName === "memory_get" || toolName === "memory_read" || toolName === "read") {
    return "read";
  }
  if (toolName === "write") {
    return "write";
  }
  if (toolName === "edit") {
    return "edit";
  }
  // Fallback based on toolInput
  if (toolInput?.content !== undefined) {
    return "write";
  }
  return "read";
}

function getFilePath(toolName: string, toolInput?: Record<string, unknown>): string | undefined {
  if (toolName === "memory_search") {
    return undefined;
  }
  return (toolInput?.path ?? toolInput?.file_path ?? toolInput?.relPath) as string | undefined;
}

function getToolUseSnippet(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string | undefined {
  if (!toolInput) {
    return undefined;
  }

  // For search tools, show the query
  if (toolName === "memory_search" && toolInput.query) {
    const q = String(toolInput.query as string);
    return q.length > 120 ? q.slice(0, 120) + "..." : q;
  }

  // For write/edit, show a snippet of the content
  const content = (toolInput.content ?? toolInput.new_string) as string | undefined;
  if (content) {
    return content.length > 120 ? content.slice(0, 120) + "..." : content;
  }

  // For read, show the path
  const path = (toolInput.path ?? toolInput.file_path) as string | undefined;
  if (path) {
    return path;
  }

  return undefined;
}
