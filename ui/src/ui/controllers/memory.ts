import type { GatewayBrowserClient } from "../gateway.ts";

export type MemorySource = "memory" | "sessions";

export type MemoryProviderStatusUI = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

export type MemoryStatusResult = {
  agentId: string;
  status: MemoryProviderStatusUI | null;
  error?: string;
};

export type MemoryState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  memoryLoading: boolean;
  memoryStatus: MemoryStatusResult | null;
  memoryError: string | null;
};

export async function loadMemoryStatus(state: MemoryState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.memoryLoading) {
    return;
  }
  state.memoryLoading = true;
  state.memoryError = null;
  try {
    const res = await state.client.request<MemoryStatusResult | undefined>("memory.status", {});
    if (res) {
      state.memoryStatus = res;
      if (res.error) {
        state.memoryError = res.error;
      }
    }
  } catch (err) {
    state.memoryError = err instanceof Error ? err.message : String(err);
  } finally {
    state.memoryLoading = false;
  }
}
