import { switchChatSession } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import {
  addProjectResourceFromPath,
  addProjectResourceNote,
  archiveSelectedProject,
  attachSessionToProject,
  createProject,
  createProjectChat,
  loadProjects,
  reindexProjectResource,
  removeProjectResource,
  restoreProject,
  selectProject,
  updateSelectedProject,
  uploadProjectResourceFile,
} from "./controllers/projects.ts";
import { renderProjects } from "./views/projects.ts";

function confirmProjectArchive(state: AppViewState): boolean {
  const projectName = state.projectsDetail?.project?.name ?? "this project";
  return window.confirm(
    `Archive ${projectName}? It will leave active OpenClaw Mac Studio Projects, but its stored data is kept.`,
  );
}

export function renderProjectsTab(state: AppViewState) {
  return renderProjects({
    loading: state.projectsLoading,
    saving: state.projectsSaving,
    error: state.projectsError,
    list: state.projectsList,
    selectedId: state.projectsSelectedId,
    detail: state.projectsDetail,
    contextPreview: state.projectsContextPreview,
    sessions: state.projectsSessions,
    currentSessionKey: state.sessionKey,
    createName: state.projectCreateName,
    createDescription: state.projectCreateDescription,
    createInstructions: state.projectCreateInstructions,
    resourcePath: state.projectResourcePath,
    resourceName: state.projectResourceName,
    resourceNote: state.projectResourceNote,
    searchQuery: state.projectSearchQuery,
    instructionsDraft: state.projectInstructionsDraft,
    onRefresh: () => loadProjects(state),
    onSelect: (projectId) => void selectProject(state, projectId),
    onCreateFieldChange: (field, value) => {
      if (field === "name") {
        state.projectCreateName = value;
      } else if (field === "description") {
        state.projectCreateDescription = value;
      } else {
        state.projectCreateInstructions = value;
      }
    },
    onCreate: () =>
      void createProject(state, {
        name: state.projectCreateName,
        description: state.projectCreateDescription,
        instructions: state.projectCreateInstructions,
      }),
    onUpdate: (patch) => void updateSelectedProject(state, patch),
    onInstructionsDraftChange: (value) => {
      state.projectInstructionsDraft = value;
    },
    onArchive: () => {
      if (confirmProjectArchive(state)) {
        void archiveSelectedProject(state);
      }
    },
    onRestore: (projectId) => void restoreProject(state, projectId),
    onResourceFieldChange: (field, value) => {
      if (field === "path") {
        state.projectResourcePath = value;
      } else if (field === "name") {
        state.projectResourceName = value;
      } else {
        state.projectResourceNote = value;
      }
    },
    onSearchChange: (value) => {
      state.projectSearchQuery = value;
    },
    onAddResourcePath: () => void addProjectResourceFromPath(state),
    onAddResourceNote: () => void addProjectResourceNote(state),
    onUploadResourceFiles: (files) => {
      void (async () => {
        for (const file of files) {
          await uploadProjectResourceFile(state, file);
        }
      })();
    },
    onRemoveResource: (projectId, resourceId) =>
      void removeProjectResource(state, projectId, resourceId),
    onReindexResource: (projectId, resourceId) =>
      void reindexProjectResource(state, projectId, resourceId),
    onAttachCurrentSession: (projectId) =>
      void attachSessionToProject(state, projectId, state.sessionKey),
    onNewProjectChat: (projectId) => {
      void createProjectChat(state, projectId).then((key) => {
        if (!key) {
          return;
        }
        switchChatSession(state, key);
        state.setTab("chat" as import("./navigation.ts").Tab);
      });
    },
    onOpenSession: (sessionKey) => {
      switchChatSession(state, sessionKey);
      state.setTab("chat" as import("./navigation.ts").Tab);
    },
  });
}
