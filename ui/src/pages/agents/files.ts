import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsFilesSetResult,
} from "../../api/types.ts";
import type { AgentCapability } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";

type AgentFileVersion = { hash: string } | { missing: true };

export type AgentFileOutcome =
  | { result: boolean; error?: never }
  | { error: string; result?: never };

type AgentFileEditor = {
  workspace?: string;
  baseWorkspace?: string;
  content?: string;
  draft?: string;
  baseVersion?: AgentFileVersion;
  version?: AgentFileVersion;
};

export type AgentFilesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  agents: Pick<AgentCapability, "recordFile">;
  agentFilesLoading: boolean;
  agentFileRead: Promise<AgentFileOutcome> | null;
  agentFileOutcome: Promise<AgentFileOutcome> | null;
  agentFileEditors: Record<string, AgentFileEditor>;
  agentFileConflict: string | null;
  agentFileSaving: boolean;
  agentFileWriteRevisions: Map<string, number>;
};

export type AgentFilesViewState = Pick<
  AgentFilesState,
  | "agentFilesLoading"
  | "agentFileRead"
  | "agentFileOutcome"
  | "agentFileEditors"
  | "agentFileSaving"
  | "agentFileConflict"
> & {
  agentFilesList: AgentsFilesListResult | null;
  agentFileActive: string | null;
};

/** Retire the selected agent's file cache and drafts with its request generation. */
export function resetAgentFiles(state: AgentFilesState & AgentFilesViewState): void {
  state.agentFilesList = null;
  state.agentFileRead = null;
  state.agentFileOutcome = null;
  state.agentFileActive = null;
  state.agentFileEditors = {};
  state.agentFileConflict = null;
  state.agentFileWriteRevisions.clear();
  state.agentFilesLoading = false;
  state.agentFileSaving = false;
}

export function hasAgentFileContent(
  state: Pick<AgentFilesState, "agentFileEditors">,
  name: string,
): boolean {
  const file = state.agentFileEditors[name];
  return Boolean(file && (Object.hasOwn(file, "content") || Object.hasOwn(file, "draft")));
}

export function isAgentFileDirty(file: AgentFileEditor | undefined): boolean {
  return Boolean(
    file &&
    Object.hasOwn(file, "draft") &&
    (file.draft !== file.content || file.workspace !== file.baseWorkspace),
  );
}

export type RetainedAgentFileDrafts = {
  editors: Record<string, Pick<AgentFileEditor, "draft" | "version" | "workspace">>;
  active: string | null;
  conflict: string | null;
};

export function retainAgentFileDrafts(
  state: AgentFilesState & { agentFileActive: string | null },
): RetainedAgentFileDrafts | null {
  const entries = Object.entries(state.agentFileEditors).filter(
    ([name, file]) => isAgentFileDirty(file) || state.agentFileConflict === name,
  );
  if (entries.length === 0) {
    return null;
  }
  return {
    editors: Object.fromEntries(
      entries.map(([name, { draft, version, workspace }]) => [name, { draft, version, workspace }]),
    ),
    active: state.agentFileActive,
    conflict: state.agentFileConflict,
  };
}

async function requestAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  operation:
    | { kind: "read"; force?: boolean; resolution?: "draft" | "hash" }
    | { kind: "write"; content: string },
): Promise<boolean> {
  const saving = operation.kind === "write";
  const busy = saving ? "agentFileSaving" : "agentFilesLoading";
  const client = state.client;
  const agents = state.agents;
  if (!client || !state.connected || state[busy] || (saving && !hasAgentFileContent(state, name))) {
    return false;
  }
  if (
    operation.kind === "read" &&
    !operation.force &&
    Object.hasOwn(state.agentFileEditors[name] ?? {}, "content")
  ) {
    return true;
  }
  const generation = state.requestGeneration;
  const isConnected = () =>
    state.client === client &&
    state.agents === agents &&
    state.connected &&
    state.requestGeneration === generation;
  const advanceWriteRevision = () => {
    state.agentFileWriteRevisions.set(name, (state.agentFileWriteRevisions.get(name) ?? 0) + 1);
  };
  // Retire reads admitted before a write, and again on settlement for reads
  // admitted during it: a later read request can still return pre-write bytes.
  if (saving) {
    advanceWriteRevision();
  }
  const revision = state.agentFileWriteRevisions.get(name);
  const isCurrent = () =>
    isConnected() && (saving || state.agentFileWriteRevisions.get(name) === revision);
  const { version, workspace } = state.agentFileEditors[name] ?? {};
  const resolution = operation.kind === "read" ? operation.resolution : undefined;
  const completion = Promise.withResolvers<AgentFileOutcome>();
  state.agentFileOutcome = completion.promise;
  if (!saving) {
    state.agentFileRead = completion.promise;
  }
  state[busy] = true;
  try {
    const res = await client.request<AgentsFilesGetResult | AgentsFilesSetResult | null>(
      saving ? "agents.files.set" : "agents.files.get",
      {
        agentId,
        name,
        ...(operation.kind === "write"
          ? {
              content: operation.content,
              ...(workspace ? { expectedWorkspace: workspace } : {}),
              ...(version &&
                ("hash" in version ? { expectedHash: version.hash } : { expectedMissing: true })),
            }
          : {}),
      },
    );
    if (res?.file && isCurrent()) {
      const content = operation.kind === "write" ? operation.content : (res.file.content ?? "");
      const file = state.agentFileEditors[name] ?? {};
      const nextVersion: AgentFileVersion | undefined = res.file.missing
        ? { missing: true }
        : res.file.hash
          ? { hash: res.file.hash }
          : undefined;
      // Reads rebase clean drafts; writes preserve edits made after submission.
      const rebasesDraft =
        resolution === "draft" ||
        !Object.hasOwn(file, "draft") ||
        (file.workspace === res.workspace && file.draft === content) ||
        (!saving && !isAgentFileDirty(file));
      const rebasesVersion = saving || resolution !== undefined || rebasesDraft;
      // Refresh advances the workspace base while dirty drafts retain their ancestry.
      state.agentFileEditors = {
        ...state.agentFileEditors,
        [name]: {
          content,
          baseWorkspace: res.workspace,
          workspace: rebasesVersion ? res.workspace : file.workspace,
          draft: rebasesDraft ? content : file.draft,
          baseVersion: nextVersion,
          version: rebasesVersion ? nextVersion : file.version,
        },
      };
      if (rebasesVersion && state.agentFileConflict === name) {
        state.agentFileConflict = null;
      }
      state.agentFileOutcome = completion.promise;
      agents.recordFile(res);
      completion.resolve({ result: true });
      return true;
    }
  } catch (err) {
    if (isCurrent()) {
      state.agentFileOutcome = completion.promise;
      completion.resolve({ error: formatUiError(err) });
      if (
        err instanceof GatewayRequestError &&
        isRecord(err.details) &&
        err.details.type === "agent_file_conflict"
      ) {
        state.agentFileConflict = name;
      }
    }
    return false;
  } finally {
    completion.resolve({ result: false });
    if (isConnected()) {
      if (saving) {
        advanceWriteRevision();
      }
      state[busy] = false;
    }
  }
  return false;
}

export function loadAgentFileContent(
  state: AgentFilesState,
  agentId: string,
  name: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  return requestAgentFile(state, agentId, name, { kind: "read", force: opts?.force });
}

function saveAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  content: string,
): Promise<boolean> {
  return requestAgentFile(state, agentId, name, { kind: "write", content });
}

function resetAgentFile(state: AgentFilesState, name: string): void {
  const file = state.agentFileEditors[name];
  if (!file || !Object.hasOwn(file, "content")) {
    return;
  }
  state.agentFileEditors = {
    ...state.agentFileEditors,
    [name]: {
      ...file,
      draft: file.content ?? "",
      version: file.baseVersion,
      workspace: file.baseWorkspace,
    },
  };
  if (state.agentFileConflict === name) {
    state.agentFileConflict = null;
    state.agentFileOutcome = null;
  }
}

function reloadAgentFile(state: AgentFilesState, agentId: string, name: string): Promise<boolean> {
  return requestAgentFile(state, agentId, name, {
    kind: "read",
    force: true,
    resolution: "draft",
  });
}

async function overwriteAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  content: string,
): Promise<boolean> {
  const client = state.client;
  const agents = state.agents;
  const generation = state.requestGeneration;
  const rebased = await requestAgentFile(state, agentId, name, {
    kind: "read",
    force: true,
    resolution: "hash",
  });
  // Publishing the read can retire its scope before this continuation dispatches a write.
  if (
    !rebased ||
    !state.connected ||
    state.client !== client ||
    state.agents !== agents ||
    state.requestGeneration !== generation
  ) {
    return false;
  }
  return await requestAgentFile(state, agentId, name, { kind: "write", content });
}

export function createAgentFileActions(
  state: AgentFilesState & { agentsSelectedId: string | null; agentFileActive: string | null },
  selectedAgentId: string | null,
  canWrite: () => boolean,
) {
  function save(name: string, write = saveAgentFile) {
    if (!selectedAgentId || selectedAgentId !== state.agentsSelectedId || !canWrite()) {
      return undefined;
    }
    return write(
      state,
      selectedAgentId,
      name,
      state.agentFileEditors[name]?.draft ?? state.agentFileEditors[name]?.content ?? "",
    );
  }
  return {
    onSelectFile(this: void, name: string) {
      state.agentFileActive = name;
      if (selectedAgentId) {
        void loadAgentFileContent(state, selectedAgentId, name);
      }
    },
    onFileDraftChange(name: string, content: string) {
      if (selectedAgentId !== state.agentsSelectedId) {
        return;
      }
      state.agentFileEditors = {
        ...state.agentFileEditors,
        [name]: { ...state.agentFileEditors[name], draft: content },
      };
    },
    onFileReset(name: string) {
      if (selectedAgentId === state.agentsSelectedId) {
        resetAgentFile(state, name);
      }
    },
    onFileSave: (name: string) => save(name),
    onFileReload: (name: string) =>
      selectedAgentId ? reloadAgentFile(state, selectedAgentId, name) : undefined,
    onFileOverwrite: (name: string) => save(name, overwriteAgentFile),
  };
}
