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

const latestFsListRequestByState = new WeakMap<FilesState, number>();
const latestFsReadRequestByState = new WeakMap<FilesState, number>();

function nextRequestId(requestMap: WeakMap<FilesState, number>, state: FilesState): number {
  const nextId = (requestMap.get(state) ?? 0) + 1;
  requestMap.set(state, nextId);
  return nextId;
}

export async function loadFsDirectory(state: FilesState, dirPath?: string): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  const requestId = nextRequestId(latestFsListRequestByState, state);
  state.fsLoading = true;
  state.fsError = null;
  state.fsFileContent = null;
  state.fsFilePath = null;

  const target = dirPath ?? state.fsPath;

  try {
    const res = await state.client.request<FsListResult>("fs.list", { path: target });
    if (latestFsListRequestByState.get(state) !== requestId) {
      return;
    }
    state.fsPath = res.path;
    state.fsEntries = res.entries;
  } catch (err) {
    if (latestFsListRequestByState.get(state) !== requestId) {
      return;
    }
    state.fsError = String(err);
  } finally {
    if (latestFsListRequestByState.get(state) === requestId) {
      state.fsLoading = false;
    }
  }
}

export async function readFsFile(state: FilesState, filePath: string): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  const requestId = nextRequestId(latestFsReadRequestByState, state);
  state.fsFileLoading = true;

  try {
    const res = await state.client.request<FsReadResult>("fs.read", {
      path: filePath,
    });
    if (latestFsReadRequestByState.get(state) !== requestId) {
      return;
    }
    state.fsFilePath = res.path;
    state.fsFileContent = res.content;
  } catch (err) {
    if (latestFsReadRequestByState.get(state) !== requestId) {
      return;
    }
    state.fsFilePath = filePath;
    state.fsFileContent = `Error: ${String(err)}`;
  } finally {
    if (latestFsReadRequestByState.get(state) === requestId) {
      state.fsFileLoading = false;
    }
  }
}

export function navigateFsUp(state: FilesState): void {
  // Handle both POSIX (/) and Windows (\) separators so navigation
  // works when the gateway runs on Windows.
  const isUnc = /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(state.fsPath);
  const isDrive = /^[A-Za-z]:([/\\]|$)/.test(state.fsPath);

  if (isUnc) {
    // UNC path: \\server\share[\dir...]
    // Never navigate above \\server\share (the share root).
    const uncParts = state.fsPath
      .replace(/^[/\\]+/, "")
      .split(/[\\/]/)
      .filter(Boolean);
    if (uncParts.length <= 2) {
      void loadFsDirectory(state, `\\\\${uncParts[0]}\\${uncParts[1]}`);
      return;
    }
    uncParts.pop();
    void loadFsDirectory(state, `\\\\${uncParts.join("\\")}`);
    return;
  }

  const parts = state.fsPath.split(/[\\/]/).filter(Boolean);
  if (parts.length > 0) {
    parts.pop();
    let parent: string;
    if (parts.length === 0) {
      if (isDrive) {
        const drive = state.fsPath.slice(0, 2);
        parent = `${drive}\\`;
      } else {
        parent = "/";
      }
    } else if (isDrive) {
      // Ensure drive root keeps trailing backslash (e.g. "C:\")
      parent =
        parts.length === 1 && /^[A-Za-z]:$/.test(parts[0]) ? `${parts[0]}\\` : parts.join("\\");
    } else {
      parent = `/${parts.join("/")}`;
    }
    void loadFsDirectory(state, parent);
  }
}
