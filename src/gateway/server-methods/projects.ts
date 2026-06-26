// Project gateway methods expose project workspaces, project chat membership, and shared context.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateProjectsArchiveParams,
  validateProjectsChatsArchiveParams,
  validateProjectsChatsAttachParams,
  validateProjectsChatsDetachParams,
  validateProjectsChatsListParams,
  validateProjectsChatsPatchParams,
  validateProjectsChatsResolveParams,
  validateProjectsChatsRestoreParams,
  validateProjectsContextGetParams,
  validateProjectsContextPatchParams,
  validateProjectsCreateParams,
  validateProjectsDocumentsArchiveParams,
  validateProjectsDocumentsCreateParams,
  validateProjectsDocumentsImportParams,
  validateProjectsDocumentsListParams,
  validateProjectsDocumentsPatchParams,
  validateProjectsDocumentsRestoreParams,
  validateProjectsGetParams,
  validateProjectsListParams,
  validateProjectsPatchParams,
  validateProjectsRolesArchiveParams,
  validateProjectsRolesCreateParams,
  validateProjectsRolesListParams,
  validateProjectsRolesPatchParams,
  validateProjectsRolesRestoreParams,
  validateProjectsRestoreParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { planProjectDocumentImport } from "../../projects/project-document-import.js";
import {
  archiveProject,
  archiveProjectChat,
  archiveProjectDocument,
  archiveProjectRole,
  createProject,
  createProjectDocument,
  createProjectRole,
  detachProjectChat,
  getActiveProjectForSession,
  getProject,
  getProjectContext,
  listProjectDocuments,
  listProjectRoles,
  listProjectChats,
  listProjects,
  patchProject,
  patchProjectChat,
  patchProjectContext,
  patchProjectDocument,
  patchProjectRole,
  restoreProject,
  restoreProjectChat,
  restoreProjectDocument,
  restoreProjectRole,
  upsertProjectChat,
} from "../../projects/project-store.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function respondValidationError(
  respond: RespondFn,
  method: string,
  errors: Parameters<typeof formatValidationErrors>[0],
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors)}`,
    ),
  );
}

function respondNotFound(respond: RespondFn, label: string, id: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `${label} not found: ${id}`));
}

export const projectsHandlers: GatewayRequestHandlers = {
  "projects.list": ({ params, respond }) => {
    if (!validateProjectsListParams(params)) {
      respondValidationError(respond, "projects.list", validateProjectsListParams.errors);
      return;
    }
    respond(true, {
      projects: listProjects({
        includeArchived: params.includeArchived,
        limit: params.limit,
      }),
    });
  },
  "projects.get": ({ params, respond }) => {
    if (!validateProjectsGetParams(params)) {
      respondValidationError(respond, "projects.get", validateProjectsGetParams.errors);
      return;
    }
    const project = getProject(params.projectId);
    if (!project) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    respond(true, { project });
  },
  "projects.create": ({ params, respond }) => {
    if (!validateProjectsCreateParams(params)) {
      respondValidationError(respond, "projects.create", validateProjectsCreateParams.errors);
      return;
    }
    respond(true, { project: createProject(params) });
  },
  "projects.patch": ({ params, respond }) => {
    if (!validateProjectsPatchParams(params)) {
      respondValidationError(respond, "projects.patch", validateProjectsPatchParams.errors);
      return;
    }
    const project = patchProject(params.projectId, params);
    if (!project) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    respond(true, { project });
  },
  "projects.archive": ({ params, respond }) => {
    if (!validateProjectsArchiveParams(params)) {
      respondValidationError(respond, "projects.archive", validateProjectsArchiveParams.errors);
      return;
    }
    const project = archiveProject(params.projectId);
    if (!project) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    respond(true, { project });
  },
  "projects.restore": ({ params, respond }) => {
    if (!validateProjectsRestoreParams(params)) {
      respondValidationError(respond, "projects.restore", validateProjectsRestoreParams.errors);
      return;
    }
    const project = restoreProject(params.projectId);
    if (!project) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    respond(true, { project });
  },
  "projects.roles.list": ({ params, respond }) => {
    if (!validateProjectsRolesListParams(params)) {
      respondValidationError(
        respond,
        "projects.roles.list",
        validateProjectsRolesListParams.errors,
      );
      return;
    }
    if (!getProject(params.projectId)) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    respond(true, {
      roles: listProjectRoles({
        projectId: params.projectId,
        includeArchived: params.includeArchived,
      }),
    });
  },
  "projects.roles.create": ({ params, respond }) => {
    if (!validateProjectsRolesCreateParams(params)) {
      respondValidationError(
        respond,
        "projects.roles.create",
        validateProjectsRolesCreateParams.errors,
      );
      return;
    }
    if (!getProject(params.projectId)) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    const role = createProjectRole(params);
    if (!role) {
      respondNotFound(respond, "project role", params.name);
      return;
    }
    respond(true, { role });
  },
  "projects.roles.patch": ({ params, respond }) => {
    if (!validateProjectsRolesPatchParams(params)) {
      respondValidationError(
        respond,
        "projects.roles.patch",
        validateProjectsRolesPatchParams.errors,
      );
      return;
    }
    const role = patchProjectRole({
      projectId: params.projectId,
      roleKey: params.roleKey,
      patch: params,
    });
    if (!role) {
      respondNotFound(respond, "project role", params.roleKey);
      return;
    }
    respond(true, { role });
  },
  "projects.roles.archive": ({ params, respond }) => {
    if (!validateProjectsRolesArchiveParams(params)) {
      respondValidationError(
        respond,
        "projects.roles.archive",
        validateProjectsRolesArchiveParams.errors,
      );
      return;
    }
    const role = archiveProjectRole(params);
    if (!role) {
      respondNotFound(respond, "project role", params.roleKey);
      return;
    }
    respond(true, { role });
  },
  "projects.roles.restore": ({ params, respond }) => {
    if (!validateProjectsRolesRestoreParams(params)) {
      respondValidationError(
        respond,
        "projects.roles.restore",
        validateProjectsRolesRestoreParams.errors,
      );
      return;
    }
    const role = restoreProjectRole(params);
    if (!role) {
      respondNotFound(respond, "project role", params.roleKey);
      return;
    }
    respond(true, { role });
  },
  "projects.documents.list": ({ params, respond }) => {
    if (!validateProjectsDocumentsListParams(params)) {
      respondValidationError(
        respond,
        "projects.documents.list",
        validateProjectsDocumentsListParams.errors,
      );
      return;
    }
    if (!getProject(params.projectId)) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    respond(true, {
      documents: listProjectDocuments({
        projectId: params.projectId,
        includeArchived: params.includeArchived,
      }),
    });
  },
  "projects.documents.create": ({ params, respond }) => {
    if (!validateProjectsDocumentsCreateParams(params)) {
      respondValidationError(
        respond,
        "projects.documents.create",
        validateProjectsDocumentsCreateParams.errors,
      );
      return;
    }
    if (!getProject(params.projectId)) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    const document = createProjectDocument(params);
    if (!document) {
      respondNotFound(respond, "project document", params.title);
      return;
    }
    respond(true, { document });
  },
  "projects.documents.import": ({ params, respond }) => {
    if (!validateProjectsDocumentsImportParams(params)) {
      respondValidationError(
        respond,
        "projects.documents.import",
        validateProjectsDocumentsImportParams.errors,
      );
      return;
    }
    if (!getProject(params.projectId)) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    const existingDocuments = listProjectDocuments({
      projectId: params.projectId,
      includeArchived: true,
    });
    const plan = planProjectDocumentImport({
      ...params,
      existingDocuments,
    });
    const documents = plan.candidates
      .map((candidate, index) =>
        createProjectDocument({
          projectId: params.projectId,
          ...candidate,
          sortOrder: existingDocuments.length + index,
        }),
      )
      .filter((document) => Boolean(document));
    respond(true, {
      documents,
      importedCount: documents.length,
      skippedCount: plan.skippedCount,
      scannedCount: plan.scannedCount,
    });
  },
  "projects.documents.patch": ({ params, respond }) => {
    if (!validateProjectsDocumentsPatchParams(params)) {
      respondValidationError(
        respond,
        "projects.documents.patch",
        validateProjectsDocumentsPatchParams.errors,
      );
      return;
    }
    const document = patchProjectDocument({
      projectId: params.projectId,
      documentId: params.documentId,
      patch: params,
    });
    if (!document) {
      respondNotFound(respond, "project document", params.documentId);
      return;
    }
    respond(true, { document });
  },
  "projects.documents.archive": ({ params, respond }) => {
    if (!validateProjectsDocumentsArchiveParams(params)) {
      respondValidationError(
        respond,
        "projects.documents.archive",
        validateProjectsDocumentsArchiveParams.errors,
      );
      return;
    }
    const document = archiveProjectDocument(params);
    if (!document) {
      respondNotFound(respond, "project document", params.documentId);
      return;
    }
    respond(true, { document });
  },
  "projects.documents.restore": ({ params, respond }) => {
    if (!validateProjectsDocumentsRestoreParams(params)) {
      respondValidationError(
        respond,
        "projects.documents.restore",
        validateProjectsDocumentsRestoreParams.errors,
      );
      return;
    }
    const document = restoreProjectDocument(params);
    if (!document) {
      respondNotFound(respond, "project document", params.documentId);
      return;
    }
    respond(true, { document });
  },
  "projects.chats.list": ({ params, respond }) => {
    if (!validateProjectsChatsListParams(params)) {
      respondValidationError(
        respond,
        "projects.chats.list",
        validateProjectsChatsListParams.errors,
      );
      return;
    }
    if (!getProject(params.projectId)) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    respond(true, {
      chats: listProjectChats({
        projectId: params.projectId,
        includeArchived: params.includeArchived,
      }),
    });
  },
  "projects.chats.resolve": ({ params, respond }) => {
    if (!validateProjectsChatsResolveParams(params)) {
      respondValidationError(
        respond,
        "projects.chats.resolve",
        validateProjectsChatsResolveParams.errors,
      );
      return;
    }
    const resolved = getActiveProjectForSession(params.sessionKey);
    respond(true, {
      project: resolved?.project,
      chat: resolved?.chat,
    });
  },
  "projects.chats.attach": ({ params, respond }) => {
    if (!validateProjectsChatsAttachParams(params)) {
      respondValidationError(
        respond,
        "projects.chats.attach",
        validateProjectsChatsAttachParams.errors,
      );
      return;
    }
    if (!getProject(params.projectId)) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    const chat = upsertProjectChat(params);
    if (!chat) {
      respondNotFound(respond, "project chat", params.sessionKey);
      return;
    }
    respond(true, { chat });
  },
  "projects.chats.patch": ({ params, respond }) => {
    if (!validateProjectsChatsPatchParams(params)) {
      respondValidationError(
        respond,
        "projects.chats.patch",
        validateProjectsChatsPatchParams.errors,
      );
      return;
    }
    const chat = patchProjectChat({
      projectId: params.projectId,
      sessionKey: params.sessionKey,
      patch: params,
    });
    if (!chat) {
      respondNotFound(respond, "project chat", params.sessionKey);
      return;
    }
    respond(true, { chat });
  },
  "projects.chats.archive": ({ params, respond }) => {
    if (!validateProjectsChatsArchiveParams(params)) {
      respondValidationError(
        respond,
        "projects.chats.archive",
        validateProjectsChatsArchiveParams.errors,
      );
      return;
    }
    const chat = archiveProjectChat(params);
    if (!chat) {
      respondNotFound(respond, "project chat", params.sessionKey);
      return;
    }
    respond(true, { chat });
  },
  "projects.chats.restore": ({ params, respond }) => {
    if (!validateProjectsChatsRestoreParams(params)) {
      respondValidationError(
        respond,
        "projects.chats.restore",
        validateProjectsChatsRestoreParams.errors,
      );
      return;
    }
    const chat = restoreProjectChat(params);
    if (!chat) {
      respondNotFound(respond, "project chat", params.sessionKey);
      return;
    }
    respond(true, { chat });
  },
  "projects.chats.detach": ({ params, respond }) => {
    if (!validateProjectsChatsDetachParams(params)) {
      respondValidationError(
        respond,
        "projects.chats.detach",
        validateProjectsChatsDetachParams.errors,
      );
      return;
    }
    if (!detachProjectChat(params)) {
      respondNotFound(respond, "project chat", params.sessionKey);
      return;
    }
    respond(true, {});
  },
  "projects.context.get": ({ params, respond }) => {
    if (!validateProjectsContextGetParams(params)) {
      respondValidationError(
        respond,
        "projects.context.get",
        validateProjectsContextGetParams.errors,
      );
      return;
    }
    if (!getProject(params.projectId)) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    respond(true, { context: getProjectContext(params.projectId) ?? undefined });
  },
  "projects.context.patch": ({ params, respond }) => {
    if (!validateProjectsContextPatchParams(params)) {
      respondValidationError(
        respond,
        "projects.context.patch",
        validateProjectsContextPatchParams.errors,
      );
      return;
    }
    if (!getProject(params.projectId)) {
      respondNotFound(respond, "project", params.projectId);
      return;
    }
    respond(true, { context: patchProjectContext(params.projectId, params) ?? undefined });
  },
};
