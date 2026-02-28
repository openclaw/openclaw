import type { GatewayBrowserClient } from "../gateway.ts";

export type FsEntry = {
  name: string;
  type: "file" | "directory" | "symlink";
  path: string;
};

export type FsListResult = {
  path: string;
  entries: FsEntry[];
};

export type FsReadResult = {
  path: string;
  size: number;
  truncated: boolean;
  content: string;
};

export type FilesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  fsPath: string;
  fsLoading: boolean;
  fsEntries: FsEntry[];
  fsError: string | null;
  fsFileContent: string | null;
  fsFilePath: string | null;
  fsFileLoading: boolean;
};

export async function loadFsDirectory(state: FilesState, dirPath?: string): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  state.fsLoading = true;
  state.fsError = null;
  state.fsFileContent = null;
  state.fsFilePath = null;

  const target = dirPath ?? state.fsPath;

  try {
    const res = await state.client.request<FsListResult>("fs.list", { path: target });
    state.fsPath = res.path;
    state.fsEntries = res.entries;
  } catch (err) {
    state.fsError = String(err);
  } finally {
    state.fsLoading = false;
  }
}

export async function readFsFile(state: FilesState, filePath: string): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  state.fsFileLoading = true;

  try {
    const res = await state.client.request<FsReadResult>("fs.read", {
      path: filePath,
    });
    state.fsFilePath = res.path;
    state.fsFileContent = res.content;
  } catch (err) {
    state.fsFilePath = filePath;
    state.fsFileContent = `Error: ${String(err)}`;
  } finally {
    state.fsFileLoading = false;
  }
}

export function navigateFsUp(state: FilesState): void {
  // Handle both POSIX (/) and Windows (\) separators so navigation
  // works when the gateway runs on Windows.
  const isWindows = /^[A-Za-z]:/.test(state.fsPath);
  const parts = state.fsPath.split(/[\\/]/).filter(Boolean);
  if (parts.length > 0) {
    parts.pop();
    let parent: string;
    if (parts.length === 0) {
      parent = isWindows ? state.fsPath.slice(0, 3) : "/";
    } else if (isWindows) {
      // Ensure drive root keeps trailing backslash (e.g. "C:\")
      parent =
        parts.length === 1 && /^[A-Za-z]:$/.test(parts[0]) ? `${parts[0]}\\` : parts.join("\\");
    } else {
      parent = `/${parts.join("/")}`;
    }
    void loadFsDirectory(state, parent);
  }
}
