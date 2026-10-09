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

type AgentFileEditor = {
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
  agentFilesError: string | null;
  agentFileEditors: Record<string, AgentFileEditor>;
  agentFileConflict: string | null;
  agentFileSaving: boolean;
  agentFileWriteRevisions: Map<string, number>;
};

export type AgentFilesViewState = Pick<
  AgentFilesState,
  | "agentFilesLoading"
  | "agentFilesError"
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
  state.agentFilesError = null;
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

export type RetainedAgentFileDrafts = {
  editors: Record<string, Pick<AgentFileEditor, "draft" | "version">>;
  active: string | null;
  conflict: string | null;
};

export function retainAgentFileDrafts(
  state: AgentFilesState & { agentFileActive: string | null },
): RetainedAgentFileDrafts | null {
  const entries = Object.entries(state.agentFileEditors).filter(
    ([name, file]) =>
      Object.hasOwn(file, "draft") &&
      (file.draft !== file.content || state.agentFileConflict === name),
  );
  if (entries.length === 0) {
    return null;
  }
  return {
    editors: Object.fromEntries(
      entries.map(([name, { draft, version }]) => [name, { draft, version }]),
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
  const version = state.agentFileEditors[name]?.version;
  const resolution = operation.kind === "read" ? operation.resolution : undefined;
  state[busy] = true;
  state.agentFilesError = null;
  try {
    const res = await client.request<AgentsFilesGetResult | AgentsFilesSetResult | null>(
      saving ? "agents.files.set" : "agents.files.get",
      {
        agentId,
        name,
        ...(operation.kind === "write"
          ? {
              content: operation.content,
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
        file.draft === content ||
        (!saving && file.draft === file.content);
      const rebasesVersion = saving || resolution !== undefined || rebasesDraft;
      // Refresh advances the workspace base while dirty drafts retain their ancestry.
      state.agentFileEditors = {
        ...state.agentFileEditors,
        [name]: {
          content,
          draft: rebasesDraft ? content : file.draft,
          baseVersion: nextVersion,
          version: rebasesVersion ? nextVersion : file.version,
        },
      };
      if (rebasesVersion && state.agentFileConflict === name) {
        state.agentFileConflict = null;
      }
      state.agentFilesError = null;
      agents.recordFile(res);
      return true;
    }
  } catch (err) {
    if (isCurrent()) {
      state.agentFilesError = formatUiError(err);
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

export function saveAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  content: string,
): Promise<boolean> {
  return requestAgentFile(state, agentId, name, { kind: "write", content });
}

export function resetAgentFile(state: AgentFilesState, name: string): void {
  const file = state.agentFileEditors[name];
  if (!file || !Object.hasOwn(file, "content")) {
    return;
  }
  state.agentFileEditors = {
    ...state.agentFileEditors,
    [name]: { ...file, draft: file.content ?? "", version: file.baseVersion },
  };
  if (state.agentFileConflict === name) {
    state.agentFileConflict = null;
    state.agentFilesError = null;
  }
}

export function reloadAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
): Promise<boolean> {
  return requestAgentFile(state, agentId, name, {
    kind: "read",
    force: true,
    resolution: "draft",
  });
}

export async function overwriteAgentFile(
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
