// Control UI tests cover project workspace controller behavior.
import { describe, expect, it, vi } from "vitest";
import {
  attachChatToSelectedProject,
  createSelectedProjectDocument,
  createSelectedProjectRole,
  createProject,
  detachProjectChat,
  emptyProjectContextDraft,
  emptyProjectDocumentDraft,
  emptyProjectDocumentImportDraft,
  emptyProjectRoleDraft,
  importSelectedProjectDocuments,
  loadProjects,
  patchActiveProjectChat,
  patchProjectChat,
  restoreProjectChat,
  restoreSelectedProject,
  resetCurrentSessionProjectChatDraft,
  saveCurrentSessionProjectChat,
  saveSelectedProjectContext,
  selectProject,
  syncProjectSelectionForSession,
  type ProjectsState,
} from "./projects.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<ProjectsState> = {}): ProjectsState {
  return {
    client: { request } as unknown as ProjectsState["client"],
    connected: true,
    projectsLoading: false,
    projectsSaving: false,
    projectsError: null,
    projectsResult: null,
    projectsIncludeArchived: false,
    projectsSelectedId: null,
    projectDetailLoading: false,
    projectDetail: null,
    projectChatsLoading: false,
    projectChats: [],
    projectActiveChat: null,
    projectRolesLoading: false,
    projectRoles: [],
    projectDocumentsLoading: false,
    projectDocuments: [],
    projectContextDraft: emptyProjectContextDraft(),
    projectRoleDraft: emptyProjectRoleDraft(),
    projectDocumentDraft: emptyProjectDocumentDraft(),
    projectDocumentImportDraft: emptyProjectDocumentImportDraft(),
    projectCreateName: "",
    projectCreateDescription: "",
    projectAttachSessionKey: "",
    projectAttachTitle: "",
    projectAttachRole: "",
    projectNewChatRole: "",
    projectNewChatDocumentIds: [],
    projectChatDraftTitle: "",
    projectChatDraftRole: "",
    projectChatDraftDocumentIds: [],
    ...overrides,
  };
}

const project = {
  projectId: "proj-1",
  name: "OpenClaw improvements",
  status: "active",
  createdAtMs: 1,
  updatedAtMs: 2,
  sortOrder: 0,
} as const;

describe("loadProjects", () => {
  it("loads projects and selects the first active project with detail and chats", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.list") {
        return { projects: [project] };
      }
      if (method === "projects.get") {
        return {
          project: {
            ...project,
            context: {
              projectId: project.projectId,
              summary: "Summary",
              instructions: "Instructions",
              decisions: ["Decision"],
              documents: ["Doc"],
              updatedAtMs: 3,
            },
          },
        };
      }
      if (method === "projects.chats.list") {
        return {
          chats: [
            {
              projectId: project.projectId,
              sessionKey: "agent:main:main",
              status: "active",
              sortOrder: 0,
              createdAtMs: 4,
              updatedAtMs: 5,
            },
          ],
        };
      }
      if (method === "projects.roles.list") {
        return {
          roles: [
            {
              projectId: project.projectId,
              roleKey: "implementation",
              name: "Implementation",
              status: "active",
              sortOrder: 0,
              createdAtMs: 4,
              updatedAtMs: 5,
            },
          ],
        };
      }
      if (method === "projects.documents.list") {
        return {
          documents: [
            {
              projectId: project.projectId,
              documentId: "doc-1",
              title: "Architecture inventory",
              includeInContext: true,
              status: "active",
              sortOrder: 0,
              createdAtMs: 4,
              updatedAtMs: 5,
            },
          ],
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request);

    await loadProjects(state);

    expect(request).toHaveBeenNthCalledWith(1, "projects.list", {
      includeArchived: false,
      limit: 200,
    });
    expect(request).toHaveBeenCalledWith("projects.get", { projectId: project.projectId });
    expect(request).toHaveBeenCalledWith("projects.chats.list", {
      projectId: project.projectId,
      includeArchived: true,
    });
    expect(request).toHaveBeenCalledWith("projects.roles.list", {
      projectId: project.projectId,
      includeArchived: true,
    });
    expect(request).toHaveBeenCalledWith("projects.documents.list", {
      projectId: project.projectId,
      includeArchived: true,
    });
    expect(state.projectsSelectedId).toBe(project.projectId);
    expect(state.projectDetail?.name).toBe(project.name);
    expect(state.projectContextDraft.decisions).toBe("Decision");
    expect(state.projectChats).toHaveLength(1);
    expect(state.projectRoles).toHaveLength(1);
    expect(state.projectDocuments).toHaveLength(1);
    expect(state.projectsLoading).toBe(false);
  });

  it("syncs the selected project from the active chat session", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.chats.resolve") {
        return {
          project,
          chat: {
            projectId: project.projectId,
            sessionKey: "agent:main:main",
            role: "implementation",
          },
        };
      }
      if (method === "projects.list") {
        return { projects: [project] };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, { projectsSelectedId: "proj-other" });

    await syncProjectSelectionForSession(state, "agent:main:main");

    expect(request).toHaveBeenNthCalledWith(1, "projects.chats.resolve", {
      sessionKey: "agent:main:main",
    });
    expect(request).toHaveBeenCalledWith("projects.list", {
      includeArchived: false,
      limit: 200,
    });
    expect(state.projectsSelectedId).toBe(project.projectId);
    expect(state.projectDetail?.projectId).toBe(project.projectId);
    expect(state.projectActiveChat?.role).toBe("implementation");
  });

  it("clears the selected project when the active chat is not linked", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.chats.resolve") {
        return {};
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, { projectsSelectedId: project.projectId });

    await syncProjectSelectionForSession(state, "agent:main:unlinked");

    expect(state.projectsSelectedId).toBeNull();
    expect(state.projectActiveChat).toBeNull();
  });

  it("selects a different project without reloading the list", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "projects.get") {
        return { project: { ...project, projectId: (params as { projectId: string }).projectId } };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, { projectsSelectedId: project.projectId });

    await selectProject(state, "proj-2");

    expect(request).toHaveBeenCalledWith("projects.get", { projectId: "proj-2" });
    expect(state.projectsSelectedId).toBe("proj-2");
  });
});

describe("project mutations", () => {
  it("creates a project and refreshes while preserving the new selection", async () => {
    const created = { ...project, projectId: "proj-created" };
    const request = vi.fn(async (method: string) => {
      if (method === "projects.create") {
        return { project: created };
      }
      if (method === "projects.list") {
        return { projects: [created] };
      }
      if (method === "projects.get") {
        return { project: created };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      projectCreateName: "  New project ",
      projectCreateDescription: " Useful work ",
    });

    await createProject(state);

    expect(request).toHaveBeenNthCalledWith(1, "projects.create", {
      name: "New project",
      description: "Useful work",
    });
    expect(state.projectsSelectedId).toBe("proj-created");
    expect(state.projectCreateName).toBe("");
    expect(state.projectCreateDescription).toBe("");
  });

  it("saves shared context as normalized text and line arrays", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.context.patch") {
        return {
          context: {
            projectId: project.projectId,
            summary: "Summary",
            instructions: null,
            decisions: ["A", "B"],
            documents: ["Doc"],
            updatedAtMs: 3,
          },
        };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      projectsSelectedId: project.projectId,
      projectContextDraft: {
        summary: " Summary ",
        instructions: " ",
        decisions: "A\n\n B ",
        documents: "Doc\n",
      },
    });

    await saveSelectedProjectContext(state);

    expect(request).toHaveBeenNthCalledWith(1, "projects.context.patch", {
      projectId: project.projectId,
      summary: "Summary",
      instructions: null,
      decisions: ["A", "B"],
      documents: ["Doc"],
    });
  });

  it("attaches a chat and clears the attach draft", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.chats.attach") {
        return { chat: {} };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      projectsSelectedId: project.projectId,
      projectAttachSessionKey: " agent:main:main ",
      projectAttachTitle: " Build ",
      projectAttachRole: " implementation ",
    });

    await attachChatToSelectedProject(state);

    expect(request).toHaveBeenNthCalledWith(1, "projects.chats.attach", {
      projectId: project.projectId,
      sessionKey: "agent:main:main",
      title: "Build",
      role: "implementation",
    });
    expect(state.projectAttachSessionKey).toBe("");
    expect(state.projectAttachTitle).toBe("");
    expect(state.projectAttachRole).toBe("");
  });

  it("creates a configurable project role and refreshes role state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.roles.create") {
        return { role: { projectId: project.projectId, roleKey: "design" } };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return {
          roles: [
            {
              projectId: project.projectId,
              roleKey: "design",
              name: "Design",
              status: "active",
              sortOrder: 0,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      projectsSelectedId: project.projectId,
      projectRoleDraft: {
        name: " Design ",
        description: " UX polish ",
        instructions: " Focus on clarity ",
      },
    });

    await createSelectedProjectRole(state);

    expect(request).toHaveBeenNthCalledWith(1, "projects.roles.create", {
      projectId: project.projectId,
      name: "Design",
      description: "UX polish",
      instructions: "Focus on clarity",
      sortOrder: 0,
    });
    expect(state.projectRoleDraft).toEqual(emptyProjectRoleDraft());
    expect(state.projectRoles.map((role) => role.roleKey)).toEqual(["design"]);
  });

  it("creates a project document and refreshes document state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.documents.create") {
        return { document: { projectId: project.projectId, documentId: "doc-1" } };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return {
          documents: [
            {
              projectId: project.projectId,
              documentId: "doc-1",
              title: "Spec",
              includeInContext: true,
              status: "active",
              sortOrder: 0,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      projectsSelectedId: project.projectId,
      projectDocumentDraft: {
        title: " Spec ",
        uri: " /vault/spec.md ",
        kind: " obsidian ",
        notes: " Read first ",
        includeInContext: true,
      },
    });

    await createSelectedProjectDocument(state);

    expect(request).toHaveBeenNthCalledWith(1, "projects.documents.create", {
      projectId: project.projectId,
      title: "Spec",
      uri: "/vault/spec.md",
      kind: "obsidian",
      notes: "Read first",
      includeInContext: true,
      sortOrder: 0,
    });
    expect(state.projectDocumentDraft).toEqual(emptyProjectDocumentDraft());
    expect(state.projectDocuments.map((document) => document.documentId)).toEqual(["doc-1"]);
  });

  it("imports project documents in bulk and refreshes document state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.documents.import") {
        return {
          documents: [{ projectId: project.projectId, documentId: "doc-1" }],
          importedCount: 1,
          skippedCount: 0,
          scannedCount: 1,
        };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return {
          documents: [
            {
              projectId: project.projectId,
              documentId: "doc-1",
              title: "Spec",
              includeInContext: true,
              status: "active",
              sortOrder: 0,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      projectsSelectedId: project.projectId,
      projectDocumentImportDraft: {
        text: " Spec | /vault/spec.md | obsidian ",
        roots: " /vault/project ",
        recursive: true,
        includeInContext: true,
        kind: "",
        notes: " Imported references ",
      },
    });

    await importSelectedProjectDocuments(state);

    expect(request).toHaveBeenNthCalledWith(1, "projects.documents.import", {
      projectId: project.projectId,
      text: "Spec | /vault/spec.md | obsidian",
      roots: ["/vault/project"],
      recursive: true,
      includeInContext: true,
      kind: undefined,
      notes: "Imported references",
    });
    expect(state.projectDocumentImportDraft).toEqual(emptyProjectDocumentImportDraft());
    expect(state.projectDocuments.map((document) => document.documentId)).toEqual(["doc-1"]);
  });

  it("patches the active project chat title and role", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.chats.patch") {
        return {
          chat: {
            projectId: project.projectId,
            sessionKey: "agent:main:main",
            title: "Review thread",
            role: "review",
          },
        };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return {
          chats: [
            {
              projectId: project.projectId,
              sessionKey: "agent:main:main",
              title: "Review thread",
              role: "review",
              status: "active",
              sortOrder: 0,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      sessionKey: "agent:main:main",
      projectsSelectedId: project.projectId,
    });

    await patchActiveProjectChat(state, {
      title: "Review thread",
      role: "review",
    });

    expect(request).toHaveBeenNthCalledWith(1, "projects.chats.patch", {
      projectId: project.projectId,
      sessionKey: "agent:main:main",
      title: "Review thread",
      role: "review",
    });
    expect(state.projectActiveChat).toMatchObject({
      title: "Review thread",
      role: "review",
    });
  });

  it("saves current session project chat draft by attaching when needed", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.chats.attach") {
        return {
          chat: {
            projectId: project.projectId,
            sessionKey: "agent:main:main",
            title: "Implementation thread",
            role: "implementation",
            metadata: { projectDocumentIds: ["doc-1"] },
          },
        };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return {
          chats: [
            {
              projectId: project.projectId,
              sessionKey: "agent:main:main",
              title: "Implementation thread",
              role: "implementation",
              metadata: { projectDocumentIds: ["doc-1"] },
              status: "active",
              sortOrder: 0,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      sessionKey: "agent:main:main",
      projectsSelectedId: project.projectId,
      projectChatDraftTitle: "Implementation thread",
      projectChatDraftRole: "implementation",
      projectChatDraftDocumentIds: ["doc-1"],
    });

    await saveCurrentSessionProjectChat(state);

    expect(request).toHaveBeenNthCalledWith(1, "projects.chats.attach", {
      projectId: project.projectId,
      sessionKey: "agent:main:main",
      title: "Implementation thread",
      role: "implementation",
      metadata: { projectDocumentIds: ["doc-1"] },
    });
    expect(state.projectActiveChat).toMatchObject({
      title: "Implementation thread",
      role: "implementation",
    });
  });

  it("resets the current session project chat draft from the active linked chat", () => {
    const state = createState(vi.fn(), {
      projectActiveChat: {
        projectId: project.projectId,
        sessionKey: "agent:main:main",
        title: "Saved title",
        role: "qa",
        metadata: { projectDocumentIds: ["doc-1", "doc-2"] },
        status: "active",
        sortOrder: 0,
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      projectChatDraftTitle: "Unsaved title",
      projectChatDraftRole: "implementation",
      projectChatDraftDocumentIds: ["doc-3"],
    });

    resetCurrentSessionProjectChatDraft(state);

    expect(state.projectChatDraftTitle).toBe("Saved title");
    expect(state.projectChatDraftRole).toBe("qa");
    expect(state.projectChatDraftDocumentIds).toEqual(["doc-1", "doc-2"]);
  });

  it("resets an unlinked current session project chat draft to the project default role", () => {
    const state = createState(vi.fn(), {
      projectsSelectedId: project.projectId,
      projectDetail: { ...project, defaultRoleKey: "implementation" },
      projectActiveChat: null,
      projectChatDraftTitle: "Unsaved title",
      projectChatDraftRole: "qa",
      projectChatDraftDocumentIds: ["doc-1"],
    });

    resetCurrentSessionProjectChatDraft(state);

    expect(state.projectChatDraftTitle).toBe("");
    expect(state.projectChatDraftRole).toBe("implementation");
    expect(state.projectChatDraftDocumentIds).toEqual([]);
  });

  it("patches a project chat from the project list", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.chats.patch") {
        return {
          chat: {
            projectId: project.projectId,
            sessionKey: "agent:main:main",
            title: "QA thread",
            role: "qa",
            metadata: { projectDocumentIds: ["doc-2"] },
          },
        };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return {
          chats: [
            {
              projectId: project.projectId,
              sessionKey: "agent:main:main",
              title: "QA thread",
              role: "qa",
              metadata: { projectDocumentIds: ["doc-2"] },
              status: "active",
              sortOrder: 0,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      sessionKey: "agent:main:main",
      projectsSelectedId: project.projectId,
    });

    await patchProjectChat(state, "agent:main:main", {
      title: "QA thread",
      role: "qa",
      metadata: { projectDocumentIds: ["doc-2"] },
    });

    expect(request).toHaveBeenNthCalledWith(1, "projects.chats.patch", {
      projectId: project.projectId,
      sessionKey: "agent:main:main",
      title: "QA thread",
      role: "qa",
      metadata: { projectDocumentIds: ["doc-2"] },
    });
    expect(state.projectActiveChat).toMatchObject({
      title: "QA thread",
      role: "qa",
    });
  });

  it("restores a project and refreshes the selected detail", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.restore") {
        return { project };
      }
      if (method === "projects.list") {
        return { projects: [project] };
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, {
      projectsSelectedId: project.projectId,
      projectsIncludeArchived: true,
    });

    await restoreSelectedProject(state);

    expect(request).toHaveBeenNthCalledWith(1, "projects.restore", {
      projectId: project.projectId,
    });
    expect(state.projectsSelectedId).toBe(project.projectId);
  });

  it("restores and detaches project chats", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.chats.restore") {
        return { chat: { projectId: project.projectId, sessionKey: "agent:main:main" } };
      }
      if (method === "projects.chats.detach") {
        return {};
      }
      if (method === "projects.get") {
        return { project };
      }
      if (method === "projects.chats.list") {
        return { chats: [] };
      }
      if (method === "projects.roles.list") {
        return { roles: [] };
      }
      if (method === "projects.documents.list") {
        return { documents: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const state = createState(request, { projectsSelectedId: project.projectId });

    await restoreProjectChat(state, "agent:main:main");
    await detachProjectChat(state, "agent:main:main");

    expect(request).toHaveBeenNthCalledWith(1, "projects.chats.restore", {
      projectId: project.projectId,
      sessionKey: "agent:main:main",
    });
    expect(request).toHaveBeenCalledWith("projects.chats.detach", {
      projectId: project.projectId,
      sessionKey: "agent:main:main",
    });
  });
});
