import { ErrorCodes, errorShape } from "../protocol/schema/error-codes.js";
import type { ProjectGatewayService } from "../server-projects.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

let projectsService: ProjectGatewayService | null = null;

/** Set the active ProjectGatewayService instance for RPC handlers. */
export function setProjectsService(svc: ProjectGatewayService): void {
  projectsService = svc;
}

/**
 * Validate that params.project is a non-empty string.
 * On failure, sends an error response and returns null.
 */
function validateProjectParam(
  params: Record<string, unknown>,
  respond: RespondFn,
): string | null {
  if (typeof params.project === "string" && params.project.trim()) {
    return params.project.trim();
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: project"),
  );
  return null;
}

export const projectsHandlers: GatewayRequestHandlers = {
  "projects.list": async ({ respond }) => {
    if (!projectsService) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "projects service not started"),
      );
      return;
    }
    const projects = await projectsService.listProjects();
    respond(true, { projects });
  },

  "projects.get": async ({ params, respond }) => {
    if (!projectsService) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "projects service not started"),
      );
      return;
    }
    const name = validateProjectParam(params, respond);
    if (!name) return;
    const project = await projectsService.getProject(name);
    if (!project) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `project not found: ${name}`),
      );
      return;
    }
    respond(true, { project });
  },

  "projects.board.get": async ({ params, respond }) => {
    if (!projectsService) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "projects service not started"),
      );
      return;
    }
    const name = validateProjectParam(params, respond);
    if (!name) return;
    const board = await projectsService.getBoard(name);
    if (!board) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `project not found: ${name}`),
      );
      return;
    }
    respond(true, { board });
  },

  "projects.queue.get": async ({ params, respond }) => {
    if (!projectsService) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "projects service not started"),
      );
      return;
    }
    const name = validateProjectParam(params, respond);
    if (!name) return;
    const queue = await projectsService.getQueue(name);
    if (!queue) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `project not found: ${name}`),
      );
      return;
    }
    respond(true, { queue });
  },
};
