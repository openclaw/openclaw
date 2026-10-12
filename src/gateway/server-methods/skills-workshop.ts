import {
  ErrorCodes,
  errorShape,
  validateSkillsWorkshopArchiveParams,
  validateSkillsWorkshopChangesParams,
  validateSkillsWorkshopListParams,
  validateSkillsWorkshopReadParams,
  validateSkillsWorkshopRestoreParams,
  validateSkillsWorkshopUndoParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  archiveWorkshopSkill,
  listWorkshopChanges,
  restoreWorkshopSkill,
  viewWorkshopSkill,
  WorkshopWriteError,
} from "../../skills/workshop/library.js";
import { undoWorkshopReview } from "../../skills/workshop/review-undo.js";
import { buildSkillsWorkshopListResult } from "../../skills/workshop/workshop-list.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./shared-types.js";
import {
  resolveSkillsAgentWorkspace,
  type ResolvedSkillsWorkspace,
} from "./skills-workspace-handler.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function defineWorkshopHandler<TParams>(
  method: string,
  validate: Validator<TParams>,
  run: (
    params: TParams,
    resolved: ResolvedSkillsWorkspace,
    invocation: GatewayRequestHandlerOptions,
  ) => Promise<unknown>,
): GatewayRequestHandler {
  return async (invocation) => {
    const { params, respond, context } = invocation;
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      respond(true, await run(params, resolved, invocation), undefined);
    } catch (error) {
      if (!(error instanceof WorkshopWriteError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    }
  };
}

function workshopWriteContext(
  resolved: ResolvedSkillsWorkspace,
  invocation: GatewayRequestHandlerOptions,
) {
  return {
    config: resolved.cfg,
    agentId: resolved.agentId,
    actor: "user" as const,
    assertLive: readGatewayRequestMutationAuthority(invocation).assertCurrent,
  };
}

export const skillsWorkshopHandlers: GatewayRequestHandlers = {
  "skills.workshop.list": defineWorkshopHandler(
    "skills.workshop.list",
    validateSkillsWorkshopListParams,
    (_params, resolved) =>
      buildSkillsWorkshopListResult({ config: resolved.cfg, agentId: resolved.agentId }),
  ),
  "skills.workshop.changes": defineWorkshopHandler(
    "skills.workshop.changes",
    validateSkillsWorkshopChangesParams,
    async (params, resolved) => ({
      changes: await listWorkshopChanges(resolved.agentId, {
        limit: params.limit,
        beforeMs: params.beforeMs,
      }),
    }),
  ),
  "skills.workshop.read": defineWorkshopHandler(
    "skills.workshop.read",
    validateSkillsWorkshopReadParams,
    (params, resolved) =>
      viewWorkshopSkill(
        resolved.cfg,
        resolved.agentId,
        params.name,
        params.filePath,
        params.versionId,
      ),
  ),
  "skills.workshop.archive": defineWorkshopHandler(
    "skills.workshop.archive",
    validateSkillsWorkshopArchiveParams,
    // Captured at admission; the library rechecks it before each final file effect.
    async (params, resolved, invocation) => ({
      change: await archiveWorkshopSkill(workshopWriteContext(resolved, invocation), {
        name: params.name,
        reason: params.reason,
      }),
    }),
  ),
  "skills.workshop.restore": defineWorkshopHandler(
    "skills.workshop.restore",
    validateSkillsWorkshopRestoreParams,
    async (params, resolved, invocation) => ({
      change: await restoreWorkshopSkill(workshopWriteContext(resolved, invocation), {
        name: params.name,
        versionId: params.versionId,
      }),
    }),
  ),
  "skills.workshop.undo": defineWorkshopHandler(
    "skills.workshop.undo",
    validateSkillsWorkshopUndoParams,
    (params, resolved, invocation) =>
      undoWorkshopReview(workshopWriteContext(resolved, invocation), { runId: params.runId }),
  ),
};
