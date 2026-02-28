import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentWorkspaceEntry,
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsFilesReadResult,
  AgentsFilesSetResult,
  AgentsFilesTreeResult,
} from "../types.ts";

export type AgentFilesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFilesList: AgentsFilesListResult | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileActive: string | null;
  agentFileSaving: boolean;
  agentFilesTree: AgentsFilesTreeResult | null;
  agentFilesIncludeAll: boolean;
  agentMarkdownActivePath: string | null;
  agentMarkdownRendered: boolean;
  agentMarkdownSearch: string;
  agentMarkdownRead: AgentsFilesReadResult | null;
  agentMarkdownReadLoading: boolean;
  agentMarkdownReadError: string | null;
};

function mergeFileEntry(
  list: AgentsFilesListResult | null,
  entry: { name: string; path: string; missing: boolean; size?: number; updatedAtMs?: number },
): AgentsFilesListResult | null {
  if (!list) {
    return list;
  }
  const hasEntry = list.files.some((file) => file.name === entry.name);
  const nextFiles = hasEntry
    ? list.files.map((file) => (file.name === entry.name ? entry : file))
    : [...list.files, entry];
  return { ...list, files: nextFiles };
}

function firstReadableMarkdown(entries: AgentWorkspaceEntry[]): string | null {
  for (const entry of entries) {
    if (entry.type === "file" && entry.markdown) {
      return entry.path;
    }
  }
  for (const entry of entries) {
    if (entry.type === "file") {
      return entry.path;
    }
  }
  return null;
}

export async function loadAgentFiles(state: AgentFilesState, agentId: string) {
  if (!state.client || !state.connected || state.agentFilesLoading) {
    return;
  }
  state.agentFilesLoading = true;
  state.agentFilesError = null;
  try {
    const [listRes, treeRes] = await Promise.all([
      state.client.request<AgentsFilesListResult | null>("agents.files.list", {
        agentId,
      }),
      state.client.request<AgentsFilesTreeResult | null>("agents.files.tree", {
        agentId,
        includeAll: state.agentFilesIncludeAll,
      }),
    ]);

    if (listRes) {
      state.agentFilesList = listRes;
      if (state.agentFileActive && !listRes.files.some((file) => file.name === state.agentFileActive)) {
        state.agentFileActive = null;
      }
    }
    if (treeRes) {
      state.agentFilesTree = treeRes;
      if (
        state.agentMarkdownActivePath &&
        !treeRes.entries.some((entry) => entry.type === "file" && entry.path === state.agentMarkdownActivePath)
      ) {
        state.agentMarkdownActivePath = null;
      }
      if (!state.agentMarkdownActivePath) {
        state.agentMarkdownActivePath = firstReadableMarkdown(treeRes.entries);
      }
    }
  } catch (err) {
    state.agentFilesError = String(err);
  } finally {
    state.agentFilesLoading = false;
  }
}

export async function loadAgentFilesTree(state: AgentFilesState, agentId: string) {
  if (!state.client || !state.connected || state.agentFilesLoading) {
    return;
  }
  state.agentFilesLoading = true;
  state.agentFilesError = null;
  try {
    const treeRes = await state.client.request<AgentsFilesTreeResult | null>("agents.files.tree", {
      agentId,
      includeAll: state.agentFilesIncludeAll,
    });
    if (treeRes) {
      state.agentFilesTree = treeRes;
      if (
        state.agentMarkdownActivePath &&
        !treeRes.entries.some((entry) => entry.type === "file" && entry.path === state.agentMarkdownActivePath)
      ) {
        state.agentMarkdownActivePath = null;
      }
      if (!state.agentMarkdownActivePath) {
        state.agentMarkdownActivePath = firstReadableMarkdown(treeRes.entries);
      }
    }
  } catch (err) {
    state.agentFilesError = String(err);
  } finally {
    state.agentFilesLoading = false;
  }
}

export async function loadAgentMarkdownFile(
  state: AgentFilesState,
  agentId: string,
  filePath: string,
  opts?: { offset?: number; append?: boolean },
) {
  if (!state.client || !state.connected || state.agentMarkdownReadLoading) {
    return;
  }
  state.agentMarkdownReadLoading = true;
  state.agentMarkdownReadError = null;
  try {
    const res = await state.client.request<AgentsFilesReadResult | null>("agents.files.read", {
      agentId,
      path: filePath,
      offset: opts?.offset ?? 0,
    });
    if (res) {
      if (opts?.append && state.agentMarkdownRead?.file.path === res.file.path) {
        state.agentMarkdownRead = {
          ...res,
          content: `${state.agentMarkdownRead.content}${res.content}`,
          offset: 0,
          totalChars: res.totalChars,
        };
      } else {
        state.agentMarkdownRead = res;
      }
      state.agentMarkdownActivePath = res.file.path;
    }
  } catch (err) {
    state.agentMarkdownReadError = String(err);
  } finally {
    state.agentMarkdownReadLoading = false;
  }
}

export async function loadAgentFileContent(
  state: AgentFilesState,
  agentId: string,
  name: string,
  opts?: { force?: boolean; preserveDraft?: boolean },
) {
  if (!state.client || !state.connected || state.agentFilesLoading) {
    return;
  }
  if (!opts?.force && Object.hasOwn(state.agentFileContents, name)) {
    return;
  }
  state.agentFilesLoading = true;
  state.agentFilesError = null;
  try {
    const res = await state.client.request<AgentsFilesGetResult | null>("agents.files.get", {
      agentId,
      name,
    });
    if (res?.file) {
      const content = res.file.content ?? "";
      const previousBase = state.agentFileContents[name] ?? "";
      const currentDraft = state.agentFileDrafts[name];
      const preserveDraft = opts?.preserveDraft ?? true;
      state.agentFilesList = mergeFileEntry(state.agentFilesList, res.file);
      state.agentFileContents = { ...state.agentFileContents, [name]: content };
      if (
        !preserveDraft ||
        !Object.hasOwn(state.agentFileDrafts, name) ||
        currentDraft === previousBase
      ) {
        state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
      }
    }
  } catch (err) {
    state.agentFilesError = String(err);
  } finally {
    state.agentFilesLoading = false;
  }
}

export async function saveAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  content: string,
) {
  if (!state.client || !state.connected || state.agentFileSaving) {
    return;
  }
  state.agentFileSaving = true;
  state.agentFilesError = null;
  try {
    const res = await state.client.request<AgentsFilesSetResult | null>("agents.files.set", {
      agentId,
      name,
      content,
    });
    if (res?.file) {
      state.agentFilesList = mergeFileEntry(state.agentFilesList, res.file);
      state.agentFileContents = { ...state.agentFileContents, [name]: content };
      state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
    }
  } catch (err) {
    state.agentFilesError = String(err);
  } finally {
    state.agentFileSaving = false;
  }
}
