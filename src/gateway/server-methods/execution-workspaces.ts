/**
 * Execution workspaces RPC handlers.
 * Methods: executionWorkspaces.{create,get,list,update,archive,operations.record,operations.list}
 */
import * as ExecWsStore from "../../orchestration/execution-workspace-sqlite.js";
import type { ExecutionWorkspaceStatus } from "../../orchestration/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export const executionWorkspacesHandlers: GatewayRequestHandlers = {
  "executionWorkspaces.create": ({ params, respond }) => {
    const p = params;
    const name = asStr(p.name);
    if (!name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "name is required"));
      return;
    }
    try {
      const ws = ExecWsStore.createExecutionWorkspace({
        name,
        workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : undefined,
        projectId: typeof p.projectId === "string" ? p.projectId : undefined,
        taskId: typeof p.taskId === "string" ? p.taskId : undefined,
        agentId: typeof p.agentId === "string" ? p.agentId : undefined,
        mode: typeof p.mode === "string" ? p.mode : undefined,
        workspacePath: typeof p.workspacePath === "string" ? p.workspacePath : undefined,
        baseRef: typeof p.baseRef === "string" ? p.baseRef : undefined,
        branchName: typeof p.branchName === "string" ? p.branchName : undefined,
        metadataJson: typeof p.metadataJson === "string" ? p.metadataJson : undefined,
      });
      respond(true, ws, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "executionWorkspaces.get": ({ params, respond }) => {
    const id = asStr(params.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    try {
      const ws = ExecWsStore.getExecutionWorkspace(id);
      respond(true, ws ?? null, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "executionWorkspaces.list": ({ params, respond }) => {
    const p = params;
    try {
      const workspaces = ExecWsStore.listExecutionWorkspaces({
        workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : undefined,
        projectId: typeof p.projectId === "string" ? p.projectId : undefined,
        taskId: typeof p.taskId === "string" ? p.taskId : undefined,
        agentId: typeof p.agentId === "string" ? p.agentId : undefined,
        status: typeof p.status === "string" ? (p.status as ExecutionWorkspaceStatus) : undefined,
      });
      respond(true, { workspaces }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "executionWorkspaces.update": ({ params, respond }) => {
    const p = params;
    const id = asStr(p.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    try {
      const ws = ExecWsStore.updateExecutionWorkspace(id, {
        name: typeof p.name === "string" ? p.name : undefined,
        status: typeof p.status === "string" ? (p.status as ExecutionWorkspaceStatus) : undefined,
        workspacePath: typeof p.workspacePath === "string" ? p.workspacePath : undefined,
        baseRef: typeof p.baseRef === "string" ? p.baseRef : undefined,
        branchName: typeof p.branchName === "string" ? p.branchName : undefined,
        closedAt: typeof p.closedAt === "number" ? p.closedAt : undefined,
        metadataJson:
          typeof p.metadataJson === "string" || p.metadataJson === null
            ? p.metadataJson
            : undefined,
      });
      respond(true, ws, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "executionWorkspaces.archive": ({ params, respond }) => {
    const id = asStr(params.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    try {
      const ws = ExecWsStore.archiveExecutionWorkspace(id);
      respond(true, ws, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "executionWorkspaces.operations.record": ({ params, respond }) => {
    const p = params;
    const executionWorkspaceId = asStr(p.executionWorkspaceId);
    const operationType = asStr(p.operationType);
    if (!executionWorkspaceId || !operationType) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "executionWorkspaceId and operationType are required",
        ),
      );
      return;
    }
    try {
      const op = ExecWsStore.recordWorkspaceOperation({
        executionWorkspaceId,
        operationType,
        status:
          typeof p.status === "string"
            ? (p.status as "pending" | "running" | "completed" | "failed")
            : undefined,
        detailsJson: typeof p.detailsJson === "string" ? p.detailsJson : undefined,
      });
      respond(true, op, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "executionWorkspaces.operations.list": ({ params, respond }) => {
    const executionWorkspaceId = asStr(params.executionWorkspaceId);
    if (!executionWorkspaceId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "executionWorkspaceId is required"),
      );
      return;
    }
    try {
      const operations = ExecWsStore.listWorkspaceOperations(executionWorkspaceId);
      respond(true, { operations }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
