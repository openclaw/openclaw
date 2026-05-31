import {
  ErrorCodes,
  errorShape,
  validateProjectsContextPreviewParams,
  validateProjectsCreateParams,
  validateProjectsDeleteParams,
  validateProjectsGetParams,
  validateProjectsListParams,
  validateProjectsResourcesAddParams,
  validateProjectsResourcesListParams,
  validateProjectsResourcesReindexParams,
  validateProjectsResourcesRemoveParams,
  validateProjectsResourcesUploadParams,
  validateProjectsRestoreParams,
  validateProjectsSessionsAttachParams,
  validateProjectsSessionsDetachParams,
  validateProjectsSessionsListParams,
  validateProjectsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  archiveProject,
  addProjectResource,
  addUploadedProjectResource,
  buildProjectContextPreview,
  createProject,
  getProject,
  listProjects,
  removeProjectResource,
  reindexProjectResource,
  restoreProject,
  sanitizeProjectForClient,
  sanitizeResourceForClient,
  updateProject,
  ProjectsStoreError,
} from "../../projects/store.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  listSessionsFromStoreAsync,
  loadCombinedSessionStoreForGateway,
} from "../session-utils.js";
import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function mapProjectsError(err: unknown) {
  if (err instanceof ProjectsStoreError) {
    const code = err.code === "unavailable" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
    return errorShape(code, err.message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err));
}

async function listProjectSessions(
  context: GatewayRequestHandlerOptions["context"],
  projectId: string,
  limit?: number,
) {
  const cfg = context.getRuntimeConfig();
  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
  return await listSessionsFromStoreAsync({
    cfg,
    storePath,
    store,
    opts: {
      projectId,
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
      limit: limit ?? 50,
    },
  });
}

async function patchSessionProject(params: {
  opts: GatewayRequestHandlerOptions;
  key: string;
  projectId: string | null;
}): Promise<{ ok: true; payload: unknown } | { ok: false; error: ReturnType<typeof errorShape> }> {
  let patchedOk = false;
  let patchedPayload: unknown;
  let patchedError: ReturnType<typeof errorShape> | undefined;
  await sessionsHandlers["sessions.patch"]({
    ...params.opts,
    params: {
      key: params.key,
      projectId: params.projectId,
    },
    respond: (ok, payload, error) => {
      patchedOk = ok;
      patchedPayload = payload;
      patchedError = error;
    },
  });
  if (!patchedOk) {
    return {
      ok: false,
      error: patchedError ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to patch session project"),
    };
  }
  return { ok: true, payload: patchedPayload };
}

function respondProjectError(respond: RespondFn, err: unknown) {
  respond(false, undefined, mapProjectsError(err));
}

export const projectsHandlers: GatewayRequestHandlers = {
  "projects.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateProjectsListParams, "projects.list", respond)) {
      return;
    }
    try {
      const projects = await listProjects({ includeArchived: params.includeArchived });
      respond(
        true,
        {
          ok: true,
          ts: Date.now(),
          count: projects.length,
          projects: projects.map(sanitizeProjectForClient),
        },
        undefined,
      );
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateProjectsGetParams, "projects.get", respond)) {
      return;
    }
    try {
      const project = await getProject(params.projectId);
      const sessions =
        params.includeSessions === true
          ? await listProjectSessions(context, project.id, 50)
          : undefined;
      const preview =
        params.includeContextPreview === true ? buildProjectContextPreview(project) : undefined;
      respond(
        true,
        {
          ok: true,
          project: sanitizeProjectForClient(project),
          ...(sessions ? { sessions } : {}),
          ...(preview
            ? {
                contextPreview: {
                  ...preview,
                  project: sanitizeProjectForClient(preview.project),
                  resourcesIncluded: preview.resourcesIncluded.map(sanitizeResourceForClient),
                },
              }
            : {}),
        },
        undefined,
      );
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.create": async ({ params, respond }) => {
    if (!assertValidParams(params, validateProjectsCreateParams, "projects.create", respond)) {
      return;
    }
    try {
      const project = await createProject({
        name: params.name,
        description: normalizeOptionalString(params.description),
        instructions: normalizeOptionalString(params.instructions),
        memoryMode: params.memoryMode,
        color: normalizeOptionalString(params.color),
        emoji: normalizeOptionalString(params.emoji),
      });
      respond(true, { ok: true, project: sanitizeProjectForClient(project) }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.update": async ({ params, respond }) => {
    if (!assertValidParams(params, validateProjectsUpdateParams, "projects.update", respond)) {
      return;
    }
    try {
      const project = await updateProject(params);
      respond(true, { ok: true, project: sanitizeProjectForClient(project) }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.delete": async ({ params, respond }) => {
    if (!assertValidParams(params, validateProjectsDeleteParams, "projects.delete", respond)) {
      return;
    }
    try {
      const project = await archiveProject({ projectId: params.projectId });
      respond(true, { ok: true, project: sanitizeProjectForClient(project) }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.restore": async ({ params, respond }) => {
    if (!assertValidParams(params, validateProjectsRestoreParams, "projects.restore", respond)) {
      return;
    }
    try {
      const project = await restoreProject({ projectId: params.projectId });
      respond(true, { ok: true, project: sanitizeProjectForClient(project) }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.resources.list": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateProjectsResourcesListParams,
        "projects.resources.list",
        respond,
      )
    ) {
      return;
    }
    try {
      const project = await getProject(params.projectId);
      respond(
        true,
        {
          ok: true,
          projectId: project.id,
          resources: project.resources.map(sanitizeResourceForClient),
        },
        undefined,
      );
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.resources.add": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateProjectsResourcesAddParams,
        "projects.resources.add",
        respond,
      )
    ) {
      return;
    }
    try {
      const resource = await addProjectResource({
        projectId: params.projectId,
        name: normalizeOptionalString(params.name),
        path: normalizeOptionalString(params.path),
        content: normalizeOptionalString(params.content),
      });
      respond(true, { ok: true, resource: sanitizeResourceForClient(resource) }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.resources.upload": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateProjectsResourcesUploadParams,
        "projects.resources.upload",
        respond,
      )
    ) {
      return;
    }
    try {
      const resource = await addUploadedProjectResource({
        projectId: params.projectId,
        name: normalizeOptionalString(params.name),
        fileName: params.fileName,
        mediaType: normalizeOptionalString(params.mediaType),
        contentBase64: params.contentBase64,
      });
      respond(true, { ok: true, resource: sanitizeResourceForClient(resource) }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.resources.remove": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateProjectsResourcesRemoveParams,
        "projects.resources.remove",
        respond,
      )
    ) {
      return;
    }
    try {
      const project = await removeProjectResource({
        projectId: params.projectId,
        resourceId: params.resourceId,
      });
      respond(true, { ok: true, project: sanitizeProjectForClient(project) }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.resources.reindex": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateProjectsResourcesReindexParams,
        "projects.resources.reindex",
        respond,
      )
    ) {
      return;
    }
    try {
      const resource = await reindexProjectResource({
        projectId: params.projectId,
        resourceId: params.resourceId,
      });
      respond(true, { ok: true, resource: sanitizeResourceForClient(resource) }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.sessions.list": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateProjectsSessionsListParams,
        "projects.sessions.list",
        respond,
      )
    ) {
      return;
    }
    try {
      await getProject(params.projectId);
      const sessions = await listProjectSessions(context, params.projectId, params.limit);
      respond(true, { ok: true, projectId: params.projectId, sessions }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.sessions.attach": async (opts) => {
    const { params, respond } = opts;
    if (
      !assertValidParams(
        params,
        validateProjectsSessionsAttachParams,
        "projects.sessions.attach",
        respond,
      )
    ) {
      return;
    }
    try {
      const project = await getProject(params.projectId);
      const patched = await patchSessionProject({ opts, key: params.key, projectId: project.id });
      if (!patched.ok) {
        respond(false, undefined, patched.error);
        return;
      }
      respond(true, { ok: true, projectId: project.id, session: patched.payload }, undefined);
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
  "projects.sessions.detach": async (opts) => {
    const { params, respond } = opts;
    if (
      !assertValidParams(
        params,
        validateProjectsSessionsDetachParams,
        "projects.sessions.detach",
        respond,
      )
    ) {
      return;
    }
    const patched = await patchSessionProject({ opts, key: params.key, projectId: null });
    if (!patched.ok) {
      respond(false, undefined, patched.error);
      return;
    }
    respond(true, { ok: true, session: patched.payload }, undefined);
  },
  "projects.context.preview": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateProjectsContextPreviewParams,
        "projects.context.preview",
        respond,
      )
    ) {
      return;
    }
    try {
      const project = await getProject(params.projectId);
      const preview = buildProjectContextPreview(project, {
        query: normalizeOptionalString(params.query),
        maxChars: params.maxChars,
        maxResources: params.maxResources,
      });
      const sessions =
        params.includeSessions === true
          ? await listProjectSessions(context, project.id, 10)
          : undefined;
      respond(
        true,
        {
          ok: true,
          ...preview,
          project: sanitizeProjectForClient(preview.project),
          resourcesIncluded: preview.resourcesIncluded.map(sanitizeResourceForClient),
          ...(sessions ? { sessions } : {}),
        },
        undefined,
      );
    } catch (err) {
      respondProjectError(respond, err);
    }
  },
};
