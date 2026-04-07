import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentsWorkspaceListResult,
  AgentsWorkspaceGetResult,
  AgentsWorkspaceSetResult,
  AgentsWorkspaceDeleteResult,
  AgentsWorkspaceMkdirResult,
  AgentsWorkspaceMoveResult,
} from "../types.ts";

export type WorkspaceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  currentPath: string;
  entries: AgentsWorkspaceListResult["entries"] | null;
  selectedFile: string | null;
  fileContent: string | null;
  fileEncoding: "utf8" | "base64";
};

export async function loadWorkspaceList(state: WorkspaceState, agentId: string, path: string = "") {
  if (!state.client || !state.connected) {
    return;
  }

  state.loading = true;
  state.error = null;

  try {
    const result = await state.client.request<AgentsWorkspaceListResult>("agents.workspace.list", {
      agentId,
      path,
    });
    if (result) {
      state.entries = result.entries;
      state.currentPath = result.path;
    }
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
  }
}

export async function loadWorkspaceFile(state: WorkspaceState, agentId: string, path: string) {
  if (!state.client || !state.connected) {
    return;
  }

  state.loading = true;
  state.error = null;

  try {
    const result = await state.client.request<AgentsWorkspaceGetResult>("agents.workspace.get", {
      agentId,
      path,
    });
    if (result) {
      state.selectedFile = result.path;
      state.fileContent = result.content;
      state.fileEncoding = result.encoding;
    }
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
  }
}

export async function saveWorkspaceFile(
  state: WorkspaceState,
  agentId: string,
  path: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
) {
  if (!state.client || !state.connected) {
    return;
  }

  state.loading = true;
  state.error = null;

  try {
    const result = await state.client.request<AgentsWorkspaceSetResult>("agents.workspace.set", {
      agentId,
      path,
      content,
      encoding,
    });
    if (result) {
      // Update state to reflect saved file
      if (state.selectedFile === path) {
        state.fileContent = content;
      }
    }
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
  }
}

export async function deleteWorkspaceFile(
  state: WorkspaceState,
  agentId: string,
  path: string,
  recursive?: boolean,
) {
  if (!state.client || !state.connected) {
    return;
  }

  state.loading = true;
  state.error = null;

  try {
    await state.client.request<AgentsWorkspaceDeleteResult>("agents.workspace.delete", {
      agentId,
      path,
      recursive,
    });
    // Clear selected file if it was deleted
    if (state.selectedFile === path) {
      state.selectedFile = null;
      state.fileContent = null;
    }
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
  }
}

export async function mkdirWorkspace(
  state: WorkspaceState,
  agentId: string,
  path: string,
  parents?: boolean,
) {
  if (!state.client || !state.connected) {
    return;
  }

  state.loading = true;
  state.error = null;

  try {
    await state.client.request<AgentsWorkspaceMkdirResult>("agents.workspace.mkdir", {
      agentId,
      path,
      parents,
    });
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
  }
}

export async function moveWorkspaceFile(
  state: WorkspaceState,
  agentId: string,
  from: string,
  to: string,
  overwrite?: boolean,
) {
  if (!state.client || !state.connected) {
    return;
  }

  state.loading = true;
  state.error = null;

  try {
    await state.client.request<AgentsWorkspaceMoveResult>("agents.workspace.move", {
      agentId,
      from,
      to,
      overwrite,
    });
    // Update selected file if it was moved
    if (state.selectedFile === from) {
      state.selectedFile = to;
    }
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
  }
}
