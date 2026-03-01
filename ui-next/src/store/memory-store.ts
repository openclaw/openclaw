import { create } from "zustand";

// --- Types ---

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
  sources?: Array<"memory" | "sessions">;
  sourceCounts?: Array<{ source: string; files: number; chunks: number }>;
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

export type MemorySearchResultUI = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
  citation?: string;
};

export type MemoryFileUI = {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
};

export type ActivityEntry = {
  id: string;
  timestamp: number;
  operation: "search" | "read" | "write" | "edit";
  toolName: string;
  filePath?: string;
  query?: string;
  snippet?: string;
  sessionKey: string;
};

export type ActivityFilter = "all" | "reads" | "writes";

// --- Store ---

export type MemoryState = {
  // Files tab
  files: MemoryFileUI[];
  selectedFile: string | null;
  fileContent: string;
  originalFileContent: string;
  filesLoading: boolean;
  fileLoading: boolean;
  fileSaving: boolean;

  // Search tab
  searchQuery: string;
  searchResults: MemorySearchResultUI[];
  searching: boolean;
  searchBackend: string | null;
  searchFiles: number | null;
  searchFallback: boolean;
  searchHistory: string[];

  // Index status
  agentId: string | null;
  indexStatus: MemoryProviderStatusUI | null;
  indexLoading: boolean;
  reindexing: boolean;
  embeddingOk: boolean;
  embeddingError: string | null;
  healthy: boolean;

  // Activity log
  activityLog: ActivityEntry[];
  activityLoading: boolean;
  activityFilter: ActivityFilter;

  // Active tab
  activeTab: string;

  // Actions
  setFiles: (files: MemoryFileUI[]) => void;
  setSelectedFile: (name: string | null) => void;
  setFileContent: (content: string) => void;
  setOriginalFileContent: (content: string) => void;
  setFilesLoading: (loading: boolean) => void;
  setFileLoading: (loading: boolean) => void;
  setFileSaving: (saving: boolean) => void;

  setSearchQuery: (query: string) => void;
  setSearchResults: (results: MemorySearchResultUI[]) => void;
  setSearching: (searching: boolean) => void;
  setSearchBackend: (backend: string | null) => void;
  setSearchFiles: (files: number | null) => void;
  setSearchFallback: (fallback: boolean) => void;
  addToSearchHistory: (query: string) => void;
  loadSearchHistory: () => void;

  setAgentId: (id: string | null) => void;
  setIndexStatus: (status: MemoryProviderStatusUI | null) => void;
  setIndexLoading: (loading: boolean) => void;
  setReindexing: (reindexing: boolean) => void;
  setEmbeddingOk: (ok: boolean) => void;
  setEmbeddingError: (error: string | null) => void;
  setHealthy: (healthy: boolean) => void;

  setActivityLog: (log: ActivityEntry[]) => void;
  setActivityLoading: (loading: boolean) => void;
  setActivityFilter: (filter: ActivityFilter) => void;

  setActiveTab: (tab: string) => void;

  reset: () => void;
};

const SEARCH_HISTORY_KEY = "openclaw.memory.searchHistory";
const ACTIVE_TAB_KEY = "openclaw.memory.activeTab";
const MAX_HISTORY = 20;

function loadPersistedSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function loadPersistedActiveTab(): string {
  try {
    return localStorage.getItem(ACTIVE_TAB_KEY) ?? "index";
  } catch {
    return "index";
  }
}

const initialState = {
  files: [] as MemoryFileUI[],
  selectedFile: null as string | null,
  fileContent: "",
  originalFileContent: "",
  filesLoading: false,
  fileLoading: false,
  fileSaving: false,

  searchQuery: "",
  searchResults: [] as MemorySearchResultUI[],
  searching: false,
  searchBackend: null as string | null,
  searchFiles: null as number | null,
  searchFallback: false,
  searchHistory: loadPersistedSearchHistory(),

  agentId: null as string | null,
  indexStatus: null as MemoryProviderStatusUI | null,
  indexLoading: false,
  reindexing: false,
  embeddingOk: false,
  embeddingError: null as string | null,
  healthy: false,

  activityLog: [] as ActivityEntry[],
  activityLoading: false,
  activityFilter: "all" as ActivityFilter,

  activeTab: loadPersistedActiveTab(),
};

export const useMemoryStore = create<MemoryState>((set) => ({
  ...initialState,

  // Files
  setFiles: (files) => set({ files }),
  setSelectedFile: (name) => set({ selectedFile: name }),
  setFileContent: (content) => set({ fileContent: content }),
  setOriginalFileContent: (content) => set({ originalFileContent: content }),
  setFilesLoading: (loading) => set({ filesLoading: loading }),
  setFileLoading: (loading) => set({ fileLoading: loading }),
  setFileSaving: (saving) => set({ fileSaving: saving }),

  // Search
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchResults: (results) => set({ searchResults: results }),
  setSearching: (searching) => set({ searching: searching }),
  setSearchBackend: (backend) => set({ searchBackend: backend }),
  setSearchFiles: (files) => set({ searchFiles: files }),
  setSearchFallback: (fallback) => set({ searchFallback: fallback }),
  addToSearchHistory: (query) =>
    set((state) => {
      const trimmed = query.trim();
      if (!trimmed) {
        return state;
      }
      const filtered = state.searchHistory.filter((q) => q !== trimmed);
      const updated = [trimmed, ...filtered].slice(0, MAX_HISTORY);
      try {
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
      } catch {
        // ignore storage errors
      }
      return { searchHistory: updated };
    }),
  loadSearchHistory: () => set({ searchHistory: loadPersistedSearchHistory() }),

  // Index
  setAgentId: (id) => set({ agentId: id }),
  setIndexStatus: (status) => set({ indexStatus: status }),
  setIndexLoading: (loading) => set({ indexLoading: loading }),
  setReindexing: (reindexing) => set({ reindexing: reindexing }),
  setEmbeddingOk: (ok) => set({ embeddingOk: ok }),
  setEmbeddingError: (error) => set({ embeddingError: error }),
  setHealthy: (healthy) => set({ healthy: healthy }),

  // Activity
  setActivityLog: (log) => set({ activityLog: log }),
  setActivityLoading: (loading) => set({ activityLoading: loading }),
  setActivityFilter: (filter) => set({ activityFilter: filter }),

  // Tab
  setActiveTab: (tab) => {
    try {
      localStorage.setItem(ACTIVE_TAB_KEY, tab);
    } catch {
      // ignore
    }
    set({ activeTab: tab });
  },

  reset: () => set(initialState),
}));
