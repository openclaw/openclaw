import type { WorkspaceAgentStatus } from "../../orchestration/types.js";
/**
 * Workspaces RPC handlers
 */
import * as WorkspaceStore from "../../orchestration/workspace-store-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export const workspacesHandlers: GatewayRequestHandlers = {
  "workspaces.list": ({ respond }) => {
    try {
      const workspaces = WorkspaceStore.listWorkspaces();
      respond(true, { workspaces }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaces.get": ({ params, respond }) => {
    const p = params;
    const id = asStr(p.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    try {
      const workspace = WorkspaceStore.getWorkspace(id);
      respond(true, workspace, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaces.create": ({ params, respond }) => {
    const p = params;
    const name = asStr(p.name);
    if (!name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "name is required"));
      return;
    }
    const createParams = {
      name,
      description: typeof p.description === "string" ? p.description.trim() : undefined,
      taskPrefix: typeof p.taskPrefix === "string" ? p.taskPrefix.trim() : undefined,
      brandColor: typeof p.brandColor === "string" ? p.brandColor.trim() : undefined,
    };
    try {
      const workspace = WorkspaceStore.createWorkspace(createParams);
      respond(true, workspace, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaces.update": ({ params, respond }) => {
    const p = params;
    const id = asStr(p.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    const updateParams: { name?: string; description?: string; brandColor?: string } = {};
    if (typeof p.name === "string") {
      updateParams.name = p.name.trim();
    }
    if (typeof p.description === "string") {
      updateParams.description = p.description.trim();
    }
    if (p.description === null) {
      updateParams.description = undefined;
    }
    if (typeof p.brandColor === "string") {
      updateParams.brandColor = p.brandColor.trim();
    }
    if (p.brandColor === null) {
      updateParams.brandColor = undefined;
    }
    try {
      const workspace = WorkspaceStore.updateWorkspace(id, updateParams);
      respond(true, workspace, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaces.archive": ({ params, respond }) => {
    const p = params;
    const id = asStr(p.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    try {
      const workspace = WorkspaceStore.archiveWorkspace(id);
      respond(true, workspace, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaces.agents": ({ params, respond }) => {
    const p = params;
    const workspaceId = asStr(p.workspaceId);
    if (!workspaceId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workspaceId is required"));
      return;
    }
    try {
      const agents = WorkspaceStore.listWorkspaceAgents(workspaceId);
      respond(true, { agents }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaces.assignAgent": ({ params, respond }) => {
    const p = params;
    const workspaceId = asStr(p.workspaceId);
    const agentId = asStr(p.agentId);
    if (!workspaceId || !agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "workspaceId and agentId are required"),
      );
      return;
    }
    const role = typeof p.role === "string" ? p.role.trim() : undefined;
    try {
      WorkspaceStore.assignAgentToWorkspace(workspaceId, agentId, role);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaces.removeAgent": ({ params, respond }) => {
    const p = params;
    const workspaceId = asStr(p.workspaceId);
    const agentId = asStr(p.agentId);
    if (!workspaceId || !agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "workspaceId and agentId are required"),
      );
      return;
    }
    try {
      WorkspaceStore.removeAgentFromWorkspace(workspaceId, agentId);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "workspaces.updateAgentStatus": ({ params, respond }) => {
    const p = params;
    const workspaceId = asStr(p.workspaceId);
    const agentId = asStr(p.agentId);
    const status = asStr(p.status);
    if (!workspaceId || !agentId || !status) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "workspaceId, agentId, and status are required"),
      );
      return;
    }
    if (status !== "active" && status !== "inactive" && status !== "paused") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "status must be one of: active, inactive, paused"),
      );
      return;
    }
    const capabilities = Array.isArray(p.capabilities)
      ? (p.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
      : undefined;
    try {
      WorkspaceStore.updateWorkspaceAgentStatus(
        workspaceId,
        agentId,
        status as WorkspaceAgentStatus,
        capabilities,
      );
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
