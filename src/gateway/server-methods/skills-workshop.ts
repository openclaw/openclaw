import {
  ErrorCodes,
  errorShape,
  validateSkillsWorkshopArchiveParams,
  validateSkillsWorkshopChangesParams,
  validateSkillsWorkshopListParams,
  validateSkillsWorkshopReadParams,
  validateSkillsWorkshopRestoreParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  archiveWorkshopSkill,
  listWorkshopChanges,
  restoreWorkshopSkill,
  viewWorkshopSkill,
  WorkshopWriteError,
} from "../../skills/workshop/library.js";
import { buildSkillsWorkshopListResult } from "../../skills/workshop/workshop-list.js";
import {
  resolveSkillsAgentWorkspace,
  type ResolvedSkillsWorkspace,
} from "./skills-workspace-handler.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function defineWorkshopHandler<TParams>(
  method: string,
  validate: Validator<TParams>,
  run: (params: TParams, resolved: ResolvedSkillsWorkspace) => Promise<unknown>,
): GatewayRequestHandler {
  return async ({ params, respond, context }) => {
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      respond(true, await run(params, resolved), undefined);
    } catch (error) {
      if (!(error instanceof WorkshopWriteError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    }
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
    async (params, resolved) => ({
      change: await archiveWorkshopSkill(
        { config: resolved.cfg, agentId: resolved.agentId, actor: "user" },
        {
          name: params.name,
          reason: params.reason,
        },
      ),
    }),
  ),
  "skills.workshop.restore": defineWorkshopHandler(
    "skills.workshop.restore",
    validateSkillsWorkshopRestoreParams,
    async (params, resolved) => ({
      change: await restoreWorkshopSkill(
        { config: resolved.cfg, agentId: resolved.agentId, actor: "user" },
        {
          name: params.name,
          versionId: params.versionId,
        },
      ),
    }),
  ),
};
