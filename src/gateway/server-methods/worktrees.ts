import {
  ErrorCodes,
  errorShape,
  validateWorktreesCreateParams,
  validateWorktreesGcParams,
  validateWorktreesListParams,
  validateWorktreesRemoveParams,
  validateWorktreesRestoreParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import type { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import type { GatewayRequestHandlers } from "./types.js";

type WorktreeService = Pick<
  ManagedWorktreeService,
  "create" | "gc" | "list" | "remove" | "restore"
>;

function invalidParams(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"]): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid worktrees parameters"));
}

export function createWorktreesHandlers(service: WorktreeService): GatewayRequestHandlers {
  return {
    "worktrees.list": async ({ params, respond }) => {
      if (!validateWorktreesListParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        respond(true, { worktrees: await service.list() }, undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "worktrees.create": async ({ params, respond }) => {
      if (!validateWorktreesCreateParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        respond(
          true,
          await service.create({
            repoRoot: params.repoRoot,
            name: params.name,
            baseRef: params.baseRef,
            ownerKind: "manual",
          }),
          undefined,
        );
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "worktrees.remove": async ({ params, respond }) => {
      if (!validateWorktreesRemoveParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        const result = await service.remove({
          id: params.id,
          reason: "manual-delete",
          force: params.force,
        });
        respond(
          true,
          {
            removed: result.removed,
            ...(result.snapshotRef ? { snapshotRef: result.snapshotRef } : {}),
          },
          undefined,
        );
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "worktrees.restore": async ({ params, respond }) => {
      if (!validateWorktreesRestoreParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        respond(true, await service.restore({ id: params.id }), undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "worktrees.gc": async ({ params, respond }) => {
      if (!validateWorktreesGcParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        respond(true, await service.gc(), undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
  };
}

export const worktreesHandlers = createWorktreesHandlers(managedWorktrees);
