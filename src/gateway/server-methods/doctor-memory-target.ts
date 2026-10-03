import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  AgentSelectionRequiredError,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope-config.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestContext, GatewayRequestHandler, RespondFn } from "./types.js";

export type DoctorMemoryDreamActionPayload = {
  agentId: string;
  action:
    | "backfill"
    | "reset"
    | "resetGroundedShortTerm"
    | "repairDreamingArtifacts"
    | "dedupeDreamDiary";
  path?: string;
  found?: boolean;
  scannedFiles?: number;
  written?: number;
  replaced?: number;
  removedEntries?: number;
  removedShortTermEntries?: number;
  changed?: boolean;
  archiveDir?: string;
  archivedDreamsDiary?: boolean;
  archivedSessionCorpus?: boolean;
  archivedSessionIngestion?: boolean;
  warnings?: string[];
  dedupedEntries?: number;
  keptEntries?: number;
};

/** Resolves and validates the agent targeted by a Doctor memory request. */
export function resolveDoctorMemoryAgent(
  context: GatewayRequestContext,
  params: unknown,
  respond: RespondFn,
): { cfg: OpenClawConfig; agentId: string; requestedAgentId?: string } | null {
  const cfg = context.getRuntimeConfig();
  const rawAgentId = asOptionalRecord(params)?.agentId;
  // Validate before resolving workspace or manager state; both paths can create agent storage.
  if (rawAgentId !== undefined && typeof rawAgentId !== "string") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId must be a string"));
    return null;
  }
  const requestedAgentId =
    typeof rawAgentId === "string" ? normalizeAgentId(rawAgentId) : undefined;
  let agentId = requestedAgentId ?? tryResolveAmbientOwnerAgentId(cfg);
  if (!agentId) {
    try {
      agentId = resolveDefaultAgentId(cfg, {
        surface: "doctor memory",
        hint: "Pass agentId to select a configured agent.",
      });
    } catch (error) {
      if (!(error instanceof AgentSelectionRequiredError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return null;
    }
  }
  if (requestedAgentId && !listAgentIds(cfg).includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg, agentId, ...(requestedAgentId ? { requestedAgentId } : {}) };
}

export function resolveDoctorMemoryTarget(
  context: GatewayRequestContext,
  params: unknown,
  respond: RespondFn,
): { cfg: OpenClawConfig; agentId: string; workspaceDir: string } | null {
  const resolved = resolveDoctorMemoryAgent(context, params, respond);
  if (!resolved) {
    return null;
  }
  return {
    cfg: resolved.cfg,
    agentId: resolved.agentId,
    workspaceDir: resolveAgentWorkspaceDir(resolved.cfg, resolved.agentId),
  };
}

/** Builds a Doctor memory action handler with shared target validation. */
export function memoryActionHandler(
  action: DoctorMemoryDreamActionPayload["action"],
  run: (
    target: NonNullable<ReturnType<typeof resolveDoctorMemoryTarget>>,
  ) => Promise<Omit<DoctorMemoryDreamActionPayload, "agentId" | "action">>,
): GatewayRequestHandler {
  return async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    respond(true, { agentId: target.agentId, action, ...(await run(target)) }, undefined);
  };
}
