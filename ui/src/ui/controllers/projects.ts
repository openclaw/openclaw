// Control UI controller manages project workspace gateway state.
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  ProjectChatSummary,
  ProjectContext,
  ProjectDetail,
  ProjectDocumentSummary,
  ProjectRoleSummary,
  ProjectSummary,
  ProjectsChatsListResult,
  ProjectsChatsResolveResult,
  ProjectsContextResult,
  ProjectsDocumentsListResult,
  ProjectsDocumentsImportResult,
  ProjectsGetResult,
  ProjectsListResult,
  ProjectsRolesListResult,
} from "../types.ts";

export type ProjectContextDraft = {
  summary: string;
  instructions: string;
  decisions: string;
  documents: string;
};

export type ProjectRoleDraft = {
  name: string;
  description: string;
  instructions: string;
};

export type ProjectDocumentDraft = {
  title: string;
  uri: string;
  kind: string;
  notes: string;
  includeInContext: boolean;
};

export type ProjectDocumentImportDraft = {
  text: string;
  roots: string;
  recursive: boolean;
  includeInContext: boolean;
  kind: string;
  notes: string;
};

export type ProjectsState = {
  sessionKey?: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  projectsLoading: boolean;
  projectsSaving: boolean;
  projectsError: string | null;
  projectsResult: ProjectsListResult | null;
  projectsIncludeArchived: boolean;
  projectsSelectedId: string | null;
  projectDetailLoading: boolean;
  projectDetail: ProjectDetail | null;
  projectChatsLoading: boolean;
  projectChats: ProjectChatSummary[];
  projectActiveChat: ProjectChatSummary | null;
  projectRolesLoading: boolean;
  projectRoles: ProjectRoleSummary[];
  projectDocumentsLoading: boolean;
  projectDocuments: ProjectDocumentSummary[];
  projectContextDraft: ProjectContextDraft;
  projectRoleDraft: ProjectRoleDraft;
  projectDocumentDraft: ProjectDocumentDraft;
  projectDocumentImportDraft: ProjectDocumentImportDraft;
  projectCreateName: string;
  projectCreateDescription: string;
  projectAttachSessionKey: string;
  projectAttachTitle: string;
  projectAttachRole: string;
  projectNewChatRole: string;
  projectNewChatDocumentIds: string[];
  projectChatDraftTitle: string;
  projectChatDraftRole: string;
  projectChatDraftDocumentIds: string[];
  requestUpdate?: () => void;
};

export const PROJECT_DOCUMENT_IDS_METADATA_KEY = "projectDocumentIds";

const EMPTY_CONTEXT_DRAFT: ProjectContextDraft = {
  summary: "",
  instructions: "",
  decisions: "",
  documents: "",
};

const EMPTY_ROLE_DRAFT: ProjectRoleDraft = {
  name: "",
  description: "",
  instructions: "",
};

const EMPTY_DOCUMENT_DRAFT: ProjectDocumentDraft = {
  title: "",
  uri: "",
  kind: "",
  notes: "",
  includeInContext: true,
};

const EMPTY_DOCUMENT_IMPORT_DRAFT: ProjectDocumentImportDraft = {
  text: "",
  roots: "",
  recursive: true,
  includeInContext: true,
  kind: "",
  notes: "",
};

const sessionProjectResolveGenerations = new WeakMap<object, number>();

export function emptyProjectContextDraft(): ProjectContextDraft {
  return { ...EMPTY_CONTEXT_DRAFT };
}

export function emptyProjectRoleDraft(): ProjectRoleDraft {
  return { ...EMPTY_ROLE_DRAFT };
}

export function emptyProjectDocumentDraft(): ProjectDocumentDraft {
  return { ...EMPTY_DOCUMENT_DRAFT };
}

export function emptyProjectDocumentImportDraft(): ProjectDocumentImportDraft {
  return { ...EMPTY_DOCUMENT_IMPORT_DRAFT };
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function projectDocumentIdsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const value = metadata?.[PROJECT_DOCUMENT_IDS_METADATA_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

export function projectMetadataWithDocumentIds(
  metadata: Record<string, unknown> | undefined,
  documentIds: readonly string[],
): Record<string, unknown> | null {
  const nextMetadata = { ...(metadata ?? {}) };
  const normalizedIds = [...new Set(documentIds.map((id) => id.trim()).filter(Boolean))];
  if (normalizedIds.length > 0) {
    nextMetadata[PROJECT_DOCUMENT_IDS_METADATA_KEY] = normalizedIds;
  } else {
    delete nextMetadata[PROJECT_DOCUMENT_IDS_METADATA_KEY];
  }
  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}

export function toggleProjectDocumentId(
  documentIds: readonly string[],
  documentId: string,
  selected: boolean,
): string[] {
  const normalizedId = documentId.trim();
  if (!normalizedId) {
    return [...documentIds];
  }
  const nextIds = new Set(documentIds.map((id) => id.trim()).filter(Boolean));
  if (selected) {
    nextIds.add(normalizedId);
  } else {
    nextIds.delete(normalizedId);
  }
  return [...nextIds];
}

export function draftFromProjectContext(context: ProjectContext | null | undefined) {
  return {
    summary: context?.summary ?? "",
    instructions: context?.instructions ?? "",
    decisions: (context?.decisions ?? []).join("\n"),
    documents: (context?.documents ?? []).join("\n"),
  };
}

function getProjectErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function defaultRoleKeyForSelection(state: ProjectsState): string {
  const selectedProject =
    state.projectDetail?.projectId === state.projectsSelectedId
      ? state.projectDetail
      : state.projectsResult?.projects.find(
          (project) => project.projectId === state.projectsSelectedId,
        );
  return selectedProject?.defaultRoleKey ?? "";
}

function syncProjectChatDraftFromActiveChat(state: ProjectsState): void {
  const activeChat = state.projectActiveChat;
  if (activeChat) {
    state.projectChatDraftTitle = activeChat.title ?? "";
    state.projectChatDraftRole = activeChat.role ?? "";
    state.projectChatDraftDocumentIds = projectDocumentIdsFromMetadata(activeChat.metadata);
    return;
  }
  state.projectChatDraftTitle = "";
  state.projectChatDraftRole = defaultRoleKeyForSelection(state);
  state.projectChatDraftDocumentIds = [];
}

export function resetCurrentSessionProjectChatDraft(state: ProjectsState): void {
  syncProjectChatDraftFromActiveChat(state);
}

function selectFallbackProjectId(state: ProjectsState): string | null {
  const projects = state.projectsResult?.projects ?? [];
  const active = projects.find((project) => project.status === "active");
  return active?.projectId ?? projects[0]?.projectId ?? null;
}

async function requestProjectDetail(state: ProjectsState, projectId: string): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  state.projectDetailLoading = true;
  state.projectChatsLoading = true;
  state.projectRolesLoading = true;
  state.projectDocumentsLoading = true;
  state.projectsError = null;
  try {
    const [detailResult, chatsResult, rolesResult, documentsResult] = await Promise.all([
      state.client.request("projects.get", { projectId }) as Promise<ProjectsGetResult>,
      state.client.request("projects.chats.list", {
        projectId,
        includeArchived: true,
      }) as Promise<ProjectsChatsListResult>,
      state.client.request("projects.roles.list", {
        projectId,
        includeArchived: true,
      }) as Promise<ProjectsRolesListResult>,
      state.client.request("projects.documents.list", {
        projectId,
        includeArchived: true,
      }) as Promise<ProjectsDocumentsListResult>,
    ]);
    state.projectDetail = detailResult.project;
    state.projectContextDraft = draftFromProjectContext(detailResult.project.context ?? null);
    state.projectChats = chatsResult.chats;
    state.projectRoles = rolesResult.roles;
    state.projectDocuments = documentsResult.documents;
    const sessionKey = normalizeText(state.sessionKey);
    state.projectActiveChat =
      sessionKey && state.projectsSelectedId === projectId
        ? (chatsResult.chats.find((chat) => chat.sessionKey === sessionKey) ?? null)
        : null;
    syncProjectChatDraftFromActiveChat(state);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectDetailLoading = false;
    state.projectChatsLoading = false;
    state.projectRolesLoading = false;
    state.projectDocumentsLoading = false;
  }
}

export async function loadProjects(
  state: ProjectsState,
  opts: { preserveSelection?: boolean } = {},
): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  state.projectsLoading = true;
  state.projectsError = null;
  try {
    const result = (await state.client.request("projects.list", {
      includeArchived: state.projectsIncludeArchived,
      limit: 200,
    })) as ProjectsListResult;
    state.projectsResult = result;
    const currentSelectedId = state.projectsSelectedId;
    const hasCurrentSelection = result.projects.some(
      (project) => project.projectId === currentSelectedId,
    );
    const nextSelectedId =
      opts.preserveSelection && hasCurrentSelection
        ? currentSelectedId
        : selectFallbackProjectId(state);
    state.projectsSelectedId = nextSelectedId;
    if (nextSelectedId) {
      await requestProjectDetail(state, nextSelectedId);
    } else {
      state.projectDetail = null;
      state.projectChats = [];
      state.projectActiveChat = null;
      state.projectRoles = [];
      state.projectDocuments = [];
      state.projectContextDraft = emptyProjectContextDraft();
      state.projectRoleDraft = emptyProjectRoleDraft();
      state.projectDocumentDraft = emptyProjectDocumentDraft();
      state.projectNewChatRole = "";
      state.projectNewChatDocumentIds = [];
      state.projectChatDraftTitle = "";
      state.projectChatDraftRole = "";
      state.projectChatDraftDocumentIds = [];
    }
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsLoading = false;
  }
}

export async function selectProject(state: ProjectsState, projectId: string): Promise<void> {
  const normalized = normalizeText(projectId);
  if (!normalized || normalized === state.projectsSelectedId) {
    return;
  }
  state.projectsSelectedId = normalized;
  state.projectActiveChat = null;
  state.projectNewChatDocumentIds = [];
  await requestProjectDetail(state, normalized);
  syncProjectChatDraftFromActiveChat(state);
}

export async function syncProjectSelectionForSession(
  state: ProjectsState,
  sessionKey: string | null | undefined,
): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  const normalizedSessionKey = normalizeText(sessionKey);
  if (!normalizedSessionKey) {
    return;
  }
  const generationKey = state as object;
  const generation = (sessionProjectResolveGenerations.get(generationKey) ?? 0) + 1;
  sessionProjectResolveGenerations.set(generationKey, generation);
  try {
    const result = (await state.client.request("projects.chats.resolve", {
      sessionKey: normalizedSessionKey,
    })) as ProjectsChatsResolveResult;
    if (sessionProjectResolveGenerations.get(generationKey) !== generation) {
      return;
    }
    const projectId = result.project?.projectId;
    if (!projectId) {
      state.projectsSelectedId = null;
      state.projectActiveChat = null;
      syncProjectChatDraftFromActiveChat(state);
      return;
    }
    const resolvedChat = result.chat ?? null;
    state.projectActiveChat = resolvedChat;
    syncProjectChatDraftFromActiveChat(state);
    if (projectId === state.projectsSelectedId) {
      if (state.projectDetail?.projectId !== projectId || state.projectRoles.length === 0) {
        await loadProjects(state, { preserveSelection: true });
      }
      return;
    }
    state.projectsSelectedId = projectId;
    state.projectNewChatDocumentIds = [];
    await loadProjects(state, { preserveSelection: true });
    state.projectActiveChat = resolvedChat ?? state.projectActiveChat;
    syncProjectChatDraftFromActiveChat(state);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  }
}

export async function createProject(state: ProjectsState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  const name = normalizeText(state.projectCreateName);
  if (!name) {
    state.projectsError = "Project name is required.";
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const result = (await state.client.request("projects.create", {
      name,
      description: normalizeText(state.projectCreateDescription) || undefined,
    })) as { project: ProjectSummary };
    state.projectCreateName = "";
    state.projectCreateDescription = "";
    state.projectsSelectedId = result.project.projectId;
    state.projectNewChatDocumentIds = [];
    await loadProjects(state, { preserveSelection: true });
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function patchSelectedProject(
  state: ProjectsState,
  patch: {
    name?: string;
    description?: string | null;
    color?: string | null;
    icon?: string | null;
    defaultRoleKey?: string | null;
  },
): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.patch", {
      projectId: state.projectsSelectedId,
      ...patch,
    });
    await loadProjects(state, { preserveSelection: true });
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function archiveSelectedProject(state: ProjectsState): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.archive", { projectId: state.projectsSelectedId });
    await loadProjects(state);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function restoreSelectedProject(state: ProjectsState): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.restore", { projectId: state.projectsSelectedId });
    await loadProjects(state, { preserveSelection: true });
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function saveSelectedProjectContext(state: ProjectsState): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const context = (await state.client.request("projects.context.patch", {
      projectId: state.projectsSelectedId,
      summary: normalizeText(state.projectContextDraft.summary) || null,
      instructions: normalizeText(state.projectContextDraft.instructions) || null,
      decisions: splitLines(state.projectContextDraft.decisions),
      documents: splitLines(state.projectContextDraft.documents),
    })) as ProjectsContextResult;
    state.projectContextDraft = draftFromProjectContext(context.context ?? null);
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function attachChatToSelectedProject(state: ProjectsState): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  const sessionKey = normalizeText(state.projectAttachSessionKey);
  if (!sessionKey) {
    state.projectsError = "Session key is required.";
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.chats.attach", {
      projectId: state.projectsSelectedId,
      sessionKey,
      title: normalizeText(state.projectAttachTitle) || undefined,
      role: normalizeText(state.projectAttachRole) || undefined,
    });
    state.projectAttachSessionKey = "";
    state.projectAttachTitle = "";
    state.projectAttachRole = "";
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function patchActiveProjectChat(
  state: ProjectsState,
  patch: { title?: string | null; role?: string | null; metadata?: Record<string, unknown> | null },
): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  const sessionKey = normalizeText(state.sessionKey);
  if (!sessionKey) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const result = (await state.client.request("projects.chats.patch", {
      projectId: state.projectsSelectedId,
      sessionKey,
      ...patch,
    })) as { chat?: ProjectChatSummary };
    if (result.chat) {
      state.projectActiveChat = result.chat;
    }
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function patchProjectChat(
  state: ProjectsState,
  sessionKey: string,
  patch: { title?: string | null; role?: string | null; metadata?: Record<string, unknown> | null },
): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  const normalizedSessionKey = normalizeText(sessionKey);
  if (!normalizedSessionKey) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const result = (await state.client.request("projects.chats.patch", {
      projectId: state.projectsSelectedId,
      sessionKey: normalizedSessionKey,
      ...patch,
    })) as { chat?: ProjectChatSummary };
    if (result.chat && normalizedSessionKey === normalizeText(state.sessionKey)) {
      state.projectActiveChat = result.chat;
    }
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function saveCurrentSessionProjectChat(state: ProjectsState): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  const sessionKey = normalizeText(state.sessionKey);
  if (!sessionKey) {
    return;
  }
  const title = normalizeText(state.projectChatDraftTitle);
  const role = normalizeText(state.projectChatDraftRole);
  const roleDocumentIds = role
    ? projectDocumentIdsFromMetadata(
        state.projectRoles.find((projectRole) => projectRole.roleKey === role)?.metadata,
      )
    : [];
  const documentIds =
    state.projectChatDraftDocumentIds.length > 0
      ? state.projectChatDraftDocumentIds
      : roleDocumentIds;
  const metadata = projectMetadataWithDocumentIds(undefined, documentIds);
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    if (state.projectActiveChat) {
      const result = (await state.client.request("projects.chats.patch", {
        projectId: state.projectsSelectedId,
        sessionKey,
        title: title || null,
        role: role || null,
        metadata,
      })) as { chat?: ProjectChatSummary };
      if (result.chat) {
        state.projectActiveChat = result.chat;
      }
    } else {
      const result = (await state.client.request("projects.chats.attach", {
        projectId: state.projectsSelectedId,
        sessionKey,
        title: title || undefined,
        role: role || undefined,
        ...(metadata ? { metadata } : {}),
      })) as { chat?: ProjectChatSummary };
      if (result.chat) {
        state.projectActiveChat = result.chat;
      }
    }
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function createSelectedProjectRole(state: ProjectsState): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  const name = normalizeText(state.projectRoleDraft.name);
  if (!name) {
    state.projectsError = "Role name is required.";
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.roles.create", {
      projectId: state.projectsSelectedId,
      name,
      description: normalizeText(state.projectRoleDraft.description) || undefined,
      instructions: normalizeText(state.projectRoleDraft.instructions) || undefined,
      sortOrder: state.projectRoles.length,
    });
    state.projectRoleDraft = emptyProjectRoleDraft();
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function patchProjectRole(
  state: ProjectsState,
  roleKey: string,
  patch: {
    name?: string;
    description?: string | null;
    instructions?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.roles.patch", {
      projectId: state.projectsSelectedId,
      roleKey,
      ...patch,
    });
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function archiveProjectRole(state: ProjectsState, roleKey: string): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.roles.archive", {
      projectId: state.projectsSelectedId,
      roleKey,
    });
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function restoreProjectRole(state: ProjectsState, roleKey: string): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.roles.restore", {
      projectId: state.projectsSelectedId,
      roleKey,
    });
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function createSelectedProjectDocument(state: ProjectsState): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  const title = normalizeText(state.projectDocumentDraft.title);
  if (!title) {
    state.projectsError = "Document title is required.";
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.documents.create", {
      projectId: state.projectsSelectedId,
      title,
      uri: normalizeText(state.projectDocumentDraft.uri) || undefined,
      kind: normalizeText(state.projectDocumentDraft.kind) || undefined,
      notes: normalizeText(state.projectDocumentDraft.notes) || undefined,
      includeInContext: state.projectDocumentDraft.includeInContext,
      sortOrder: state.projectDocuments.length,
    });
    state.projectDocumentDraft = emptyProjectDocumentDraft();
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function importSelectedProjectDocuments(state: ProjectsState): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  const text = normalizeText(state.projectDocumentImportDraft.text);
  const roots = splitLines(state.projectDocumentImportDraft.roots);
  if (!text && roots.length === 0) {
    state.projectsError = "Paste document paths or add at least one folder to scan.";
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    const result = (await state.client.request("projects.documents.import", {
      projectId: state.projectsSelectedId,
      text: text || undefined,
      roots: roots.length > 0 ? roots : undefined,
      recursive: state.projectDocumentImportDraft.recursive,
      includeInContext: state.projectDocumentImportDraft.includeInContext,
      kind: normalizeText(state.projectDocumentImportDraft.kind) || undefined,
      notes: normalizeText(state.projectDocumentImportDraft.notes) || undefined,
    })) as ProjectsDocumentsImportResult;
    state.projectDocumentImportDraft = emptyProjectDocumentImportDraft();
    await requestProjectDetail(state, state.projectsSelectedId);
    if (result.importedCount === 0) {
      state.projectsError =
        result.scannedCount === 0
          ? "No document references were found to import."
          : `No new documents imported. ${result.skippedCount} duplicate reference${
              result.skippedCount === 1 ? " was" : "s were"
            } skipped.`;
    }
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function patchProjectDocument(
  state: ProjectsState,
  documentId: string,
  patch: {
    title?: string;
    uri?: string | null;
    kind?: string | null;
    notes?: string | null;
    includeInContext?: boolean;
  },
): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.documents.patch", {
      projectId: state.projectsSelectedId,
      documentId,
      ...patch,
    });
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function archiveProjectDocument(
  state: ProjectsState,
  documentId: string,
): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.documents.archive", {
      projectId: state.projectsSelectedId,
      documentId,
    });
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function restoreProjectDocument(
  state: ProjectsState,
  documentId: string,
): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.documents.restore", {
      projectId: state.projectsSelectedId,
      documentId,
    });
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function attachSessionToProject(
  state: Pick<ProjectsState, "client" | "connected">,
  params: {
    projectId: string;
    sessionKey: string;
    title?: string;
    role?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const projectId = normalizeText(params.projectId);
  const sessionKey = normalizeText(params.sessionKey);
  if (!projectId || !sessionKey) {
    return false;
  }
  const request: {
    projectId: string;
    sessionKey: string;
    title?: string;
    role?: string;
    metadata?: Record<string, unknown>;
  } = {
    projectId,
    sessionKey,
    title: normalizeText(params.title) || undefined,
    role: normalizeText(params.role) || undefined,
  };
  if (params.metadata) {
    request.metadata = params.metadata;
  }
  await state.client.request("projects.chats.attach", request);
  return true;
}

export async function archiveProjectChat(state: ProjectsState, sessionKey: string): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.chats.archive", {
      projectId: state.projectsSelectedId,
      sessionKey,
    });
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function restoreProjectChat(state: ProjectsState, sessionKey: string): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.chats.restore", {
      projectId: state.projectsSelectedId,
      sessionKey,
    });
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}

export async function detachProjectChat(state: ProjectsState, sessionKey: string): Promise<void> {
  if (!state.client || !state.connected || !state.projectsSelectedId) {
    return;
  }
  state.projectsSaving = true;
  state.projectsError = null;
  try {
    await state.client.request("projects.chats.detach", {
      projectId: state.projectsSelectedId,
      sessionKey,
    });
    await requestProjectDetail(state, state.projectsSelectedId);
  } catch (err) {
    state.projectsError = getProjectErrorMessage(err);
  } finally {
    state.projectsSaving = false;
  }
}
