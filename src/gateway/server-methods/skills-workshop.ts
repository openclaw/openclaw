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
  applyWorkshopDraft,
  discardWorkshopDraft,
  viewWorkshopDraft,
} from "../../skills/workshop/drafts.js";
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
import { defineValidatedGatewayHandler, type Validator } from "./validation.js";

function defineWorkshopHandler<TParams extends { agentId?: string } & Record<string, unknown>>(
  method: string,
  validate: Validator<TParams>,
  run: (
    params: TParams,
    resolved: ResolvedSkillsWorkspace,
    invocation: GatewayRequestHandlerOptions,
  ) => Promise<unknown>,
): GatewayRequestHandler {
  return defineValidatedGatewayHandler(method, validate, async (invocation) => {
    const { params, respond, context } = invocation;
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
  });
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

function requireDraftId(draftId: string | undefined): string {
  if (!draftId) {
    throw new WorkshopWriteError("draftId is required.");
  }
  return draftId;
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
    async (params, resolved) => {
      if (!params.draftId) {
        return viewWorkshopSkill(
          resolved.cfg,
          resolved.agentId,
          params.name,
          params.filePath,
          params.versionId,
        );
      }
      const { draft, filePath, content } = await viewWorkshopDraft(
        resolved.cfg,
        resolved.agentId,
        params.draftId,
        params.filePath,
      );
      return { name: draft.skillName, filePath, content, files: draft.files };
    },
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
  // Draft methods take the read params: `name` is the skill the caller reviewed.
  "skills.workshop.applyDraft": defineWorkshopHandler(
    "skills.workshop.applyDraft",
    validateSkillsWorkshopReadParams,
    async (params, resolved, invocation) => ({
      changes: await applyWorkshopDraft(
        workshopWriteContext(resolved, invocation),
        requireDraftId(params.draftId),
        params.name,
      ),
    }),
  ),
  "skills.workshop.discardDraft": defineWorkshopHandler(
    "skills.workshop.discardDraft",
    validateSkillsWorkshopReadParams,
    async (params, resolved, invocation) => {
      const { config, agentId, assertLive } = workshopWriteContext(resolved, invocation);
      await discardWorkshopDraft(config, agentId, requireDraftId(params.draftId), assertLive);
      return { changes: [] };
    },
  ),
  "skills.workshop.undo": defineWorkshopHandler(
    "skills.workshop.undo",
    validateSkillsWorkshopUndoParams,
    (params, resolved, invocation) =>
      undoWorkshopReview(workshopWriteContext(resolved, invocation), { runId: params.runId }),
  ),
};
