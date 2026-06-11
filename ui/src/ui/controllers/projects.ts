import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  ProjectContextPreview,
  ProjectRecord,
  ProjectResourceRecord,
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

type ProjectCreateInput = {
  name: string;
  description?: string;
  instructions?: string;
};

type ProjectUpdateInput = Partial<{
  name: string;
  description: string | null;
  instructions: string | null;
}>;

function requireClient(state: ProjectsState): GatewayBrowserClient {
  if (!state.client || !state.connected) {
    throw new Error("Gateway is not connected.");
  }
  return state.client;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeString(value: string | undefined | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
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

export async function createProject(state: ProjectsState, input: ProjectCreateInput) {
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    const response = await client.request<{ ok: true; project: ProjectRecord }>("projects.create", {
      name: input.name,
      description: normalizeString(input.description),
      instructions: normalizeString(input.instructions),
      memoryMode: "project_only",
    });
    const projectId = response?.project?.id ?? null;
    state.projectCreateName = "";
    state.projectCreateDescription = "";
    state.projectCreateInstructions = "";
    await loadProjects(state, { selectFirst: false });
    if (projectId) {
      await selectProject(state, projectId);
    }
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function updateSelectedProject(state: ProjectsState, patch: ProjectUpdateInput) {
  const projectId = state.projectsSelectedId;
  if (!projectId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    await client.request("projects.update", {
      projectId,
      ...patch,
    });
    await loadProjects(state, { selectFirst: false });
    await selectProject(state, projectId);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function archiveSelectedProject(state: ProjectsState) {
  const projectId = state.projectsSelectedId;
  if (!projectId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    await client.request("projects.delete", { projectId });
    state.projectsSelectedId = null;
    await loadProjects(state);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
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
    await selectProject(state, restoredId);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function addProjectResourceFromPath(state: ProjectsState) {
  const projectId = state.projectsSelectedId;
  const path = normalizeString(state.projectResourcePath);
  if (!projectId || !path) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    await client.request<{ ok: true; resource: ProjectResourceRecord }>("projects.resources.add", {
      projectId,
      path,
      name: normalizeString(state.projectResourceName),
    });
    state.projectResourcePath = "";
    state.projectResourceName = "";
    await loadProjectDetail(state, projectId);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function addProjectResourceNote(state: ProjectsState) {
  const projectId = state.projectsSelectedId;
  const content = normalizeString(state.projectResourceNote);
  if (!projectId || !content) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    await client.request<{ ok: true; resource: ProjectResourceRecord }>("projects.resources.add", {
      projectId,
      content,
      name: normalizeString(state.projectResourceName) ?? "Project note",
    });
    state.projectResourceNote = "";
    state.projectResourceName = "";
    await loadProjectDetail(state, projectId);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("file read failed")));
    reader.readAsDataURL(file);
  });
}

export async function uploadProjectResourceFile(state: ProjectsState, file: File) {
  const projectId = state.projectsSelectedId;
  if (!projectId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    const contentBase64 = await readFileAsBase64(file);
    await client.request<{ ok: true; resource: ProjectResourceRecord }>(
      "projects.resources.upload",
      {
        projectId,
        name: normalizeString(state.projectResourceName),
        fileName: file.name || "uploaded-resource",
        mediaType: normalizeString(file.type),
        contentBase64,
      },
    );
    state.projectResourceName = "";
    await loadProjectDetail(state, projectId);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function removeProjectResource(
  state: ProjectsState,
  projectId: string,
  resourceId: string,
) {
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    await client.request("projects.resources.remove", { projectId, resourceId });
    await loadProjectDetail(state, projectId);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function reindexProjectResource(
  state: ProjectsState,
  projectId: string,
  resourceId: string,
) {
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    await client.request("projects.resources.reindex", { projectId, resourceId });
    await loadProjectDetail(state, projectId);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function attachSessionToProject(
  state: ProjectsState,
  projectId: string,
  sessionKey: string,
) {
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    await client.request("projects.sessions.attach", { projectId, key: sessionKey });
    await loadProjectDetail(state, projectId);
  } catch (err) {
    state.projectsError = errorText(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function createProjectChat(
  state: ProjectsState,
  projectId: string,
): Promise<string | null> {
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const client = requireClient(state);
    const response = await client.request<{ ok: true; key: string }>("sessions.create", {
      projectId,
    });
    await loadProjectDetail(state, projectId);
    return response?.key ?? null;
  } catch (err) {
    state.projectsError = errorText(err);
    return null;
  } finally {
    state.projectsSaving = false;
  }
}

export async function selectProject(state: ProjectsState, projectId: string) {
  state.projectsSelectedId = projectId;
  await loadProjectDetail(state, projectId);
}
