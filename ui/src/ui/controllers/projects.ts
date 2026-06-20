import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  ProjectContextPreview,
  ProjectRecord,
  ProjectsGetResult,
  ProjectsListResult,
  SessionsListResult,
} from "../types.ts";

export type ProjectsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  projectsLoading: boolean;
  projectsSaving: boolean;
  projectsError: string | null;
  projectsList: ProjectsListResult | null;
  projectsSelectedId: string | null;
  projectsDetail: ProjectsGetResult | null;
  projectsContextPreview: ProjectContextPreview | null;
  projectsSessions: SessionsListResult | null;
  projectCreateName: string;
  projectCreateDescription: string;
  projectCreateInstructions: string;
  projectResourcePath: string;
  projectResourceName: string;
  projectResourceNote: string;
  projectSearchQuery: string;
  projectInstructionsDraft: string;
};

function requireClient(state: ProjectsState): GatewayBrowserClient {
  if (!state.client || !state.connected) {
    throw new Error("Gateway is not connected.");
  }
  return state.client;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loadProjectDetail(state: ProjectsState, projectId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.projectsError = null;
  try {
    const detail = await state.client.request<ProjectsGetResult>("projects.get", {
      projectId,
      includeSessions: true,
      includeContextPreview: true,
    });
    state.projectsDetail = detail ?? null;
    state.projectsContextPreview = detail?.contextPreview ?? null;
    state.projectsSessions = detail?.sessions ?? null;
    state.projectInstructionsDraft = detail?.project?.instructions ?? "";
  } catch (err) {
    state.projectsError = errorText(err);
  }
}

export async function loadProjects(state: ProjectsState, opts?: { selectFirst?: boolean }) {
  if (!state.client || !state.connected) {
    return;
  }
  state.projectsLoading = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    const list = await client.request<ProjectsListResult>("projects.list", {
      includeArchived: true,
    });
    state.projectsList = list ?? { ok: true, ts: Date.now(), count: 0, projects: [] };
    const activeProjects = state.projectsList.projects.filter((entry) => entry.archived !== true);
    const selectedStillExists = activeProjects.some(
      (entry) => entry.id === state.projectsSelectedId,
    );
    if (!selectedStillExists && (opts?.selectFirst ?? true)) {
      state.projectsSelectedId = activeProjects[0]?.id ?? null;
    }
    if (state.projectsSelectedId) {
      await loadProjectDetail(state, state.projectsSelectedId);
    } else {
      state.projectsDetail = null;
      state.projectsContextPreview = null;
      state.projectsSessions = null;
    }
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsLoading = false;
  }
}

export async function restoreProject(state: ProjectsState, projectId: string) {
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    const response = await client.request<{ ok: true; project: ProjectRecord }>(
      "projects.restore",
      { projectId },
    );
    const restoredId = response?.project?.id ?? projectId;
    await loadProjects(state, { selectFirst: false });
    state.projectsSelectedId = restoredId;
    await loadProjectDetail(state, restoredId);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}
