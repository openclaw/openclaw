import { clawMissionService } from "../../claw/service.js";
import type { ClawDecisionAction } from "../../shared/claw-types.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

function respondInvalidRequest(respond: RespondFn, message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function respondUnavailable(respond: RespondFn, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
}

function hasAdminScope(scopes: unknown): boolean {
  return Array.isArray(scopes) && scopes.includes(ADMIN_SCOPE);
}

function requireAdminScope(scopes: unknown, respond: RespondFn): boolean {
  if (hasAdminScope(scopes)) {
    return true;
  }
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${ADMIN_SCOPE}`));
  return false;
}

function readRequiredString(
  params: Record<string, unknown>,
  key: string,
  respond: RespondFn,
): string | null {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    respondInvalidRequest(respond, `${key} (string) is required`);
    return null;
  }
  return value.trim();
}

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalBoolean(
  params: Record<string, unknown>,
  key: string,
  respond: RespondFn,
): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    respondInvalidRequest(respond, `${key} must be a boolean`);
    return undefined;
  }
  return value;
}

function readOptionalPositiveNumber(
  params: Record<string, unknown>,
  key: string,
  respond: RespondFn,
): number | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    respondInvalidRequest(respond, `${key} must be a positive number`);
    return undefined;
  }
  return value;
}

function readDecisionAction(
  params: Record<string, unknown>,
  respond: RespondFn,
): ClawDecisionAction | null {
  const value = params.action;
  if (
    value === "approve" ||
    value === "reject" ||
    value === "pause" ||
    value === "cancel" ||
    value === "continue"
  ) {
    return value;
  }
  respondInvalidRequest(
    respond,
    'action must be one of "approve", "reject", "pause", "cancel", or "continue"',
  );
  return null;
}

function broadcastInbox(context: GatewayRequestContext): void {
  void clawMissionService
    .buildDashboard()
    .then((dashboard) => {
      context.broadcast("claw.inbox.updated", { inbox: dashboard.inbox }, { dropIfSlow: true });
    })
    .catch(() => {
      // Best-effort only.
    });
}

function broadcastMissionSnapshot(
  context: GatewayRequestContext,
  params: {
    previousStatus?: string | null;
    snapshot: Awaited<ReturnType<typeof clawMissionService.getMissionSnapshot>>;
    created?: boolean;
    decisionResolved?: boolean;
  },
): void {
  const mission = params.snapshot.mission;
  if (!mission) {
    return;
  }
  if (params.created) {
    context.broadcast("claw.mission.created", { mission }, { dropIfSlow: true });
    context.broadcast(
      "claw.decision.requested",
      {
        missionId: mission.id,
        decisions: mission.decisions.filter((decision) => decision.status === "pending"),
      },
      { dropIfSlow: true },
    );
  }
  context.broadcast("claw.mission.updated", { mission }, { dropIfSlow: true });
  if (params.previousStatus && params.previousStatus !== mission.status) {
    context.broadcast(
      "claw.mission.stateChanged",
      {
        missionId: mission.id,
        previousStatus: params.previousStatus,
        status: mission.status,
      },
      { dropIfSlow: true },
    );
  }
  if (params.decisionResolved) {
    context.broadcast(
      "claw.decision.resolved",
      { missionId: mission.id, decisions: mission.decisions },
      { dropIfSlow: true },
    );
  }
  context.broadcast(
    "claw.audit.appended",
    { missionId: mission.id, auditCount: mission.auditCount },
    { dropIfSlow: true },
  );
  broadcastInbox(context);
}

export const clawHandlers: GatewayRequestHandlers = {
  "claw.missions.list": async ({ respond }) => {
    try {
      respond(true, await clawMissionService.buildDashboard(), undefined);
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.missions.get": async ({ params, respond }) => {
    const missionId = readRequiredString(params, "missionId", respond);
    if (!missionId) {
      return;
    }
    try {
      respond(true, await clawMissionService.getMissionSnapshot(missionId), undefined);
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.missions.create": async ({ params, respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    const goal = readRequiredString(params, "goal", respond);
    if (!goal) {
      return;
    }
    const title = readOptionalString(params, "title");
    try {
      const snapshot = await clawMissionService.createMission({ goal, title });
      respond(true, snapshot, undefined);
      broadcastMissionSnapshot(context, { snapshot, created: true });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.missions.approveStart": async ({ params, respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    const missionId = readRequiredString(params, "missionId", respond);
    if (!missionId) {
      return;
    }
    try {
      const current = await clawMissionService.getMissionSnapshot(missionId);
      const previousStatus = current.mission?.status ?? null;
      const snapshot = await clawMissionService.approveMissionStart(missionId);
      respond(true, snapshot, undefined);
      broadcastMissionSnapshot(context, { previousStatus, snapshot, decisionResolved: true });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.missions.pause": async ({ params, respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    const missionId = readRequiredString(params, "missionId", respond);
    if (!missionId) {
      return;
    }
    const note = readOptionalString(params, "note");
    try {
      const current = await clawMissionService.getMissionSnapshot(missionId);
      const previousStatus = current.mission?.status ?? null;
      const snapshot = await clawMissionService.pauseMission(missionId, note);
      respond(true, snapshot, undefined);
      broadcastMissionSnapshot(context, { previousStatus, snapshot });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.missions.resume": async ({ params, respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    const missionId = readRequiredString(params, "missionId", respond);
    if (!missionId) {
      return;
    }
    try {
      const current = await clawMissionService.getMissionSnapshot(missionId);
      const previousStatus = current.mission?.status ?? null;
      const snapshot = await clawMissionService.resumeMission(missionId);
      respond(true, snapshot, undefined);
      broadcastMissionSnapshot(context, { previousStatus, snapshot });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.missions.cancel": async ({ params, respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    const missionId = readRequiredString(params, "missionId", respond);
    if (!missionId) {
      return;
    }
    const note = readOptionalString(params, "note");
    try {
      const current = await clawMissionService.getMissionSnapshot(missionId);
      const previousStatus = current.mission?.status ?? null;
      const snapshot = await clawMissionService.cancelMission(missionId, note);
      respond(true, snapshot, undefined);
      broadcastMissionSnapshot(context, { previousStatus, snapshot, decisionResolved: true });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.decisions.reply": async ({ params, respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    const missionId = readRequiredString(params, "missionId", respond);
    if (!missionId) {
      return;
    }
    const decisionId = readRequiredString(params, "decisionId", respond);
    if (!decisionId) {
      return;
    }
    const action = readDecisionAction(params, respond);
    if (!action) {
      return;
    }
    const note = readOptionalString(params, "note");
    try {
      const current = await clawMissionService.getMissionSnapshot(missionId);
      const previousStatus = current.mission?.status ?? null;
      const snapshot = await clawMissionService.replyDecision({
        missionId,
        decisionId,
        action,
        note,
      });
      respond(true, snapshot, undefined);
      broadcastMissionSnapshot(context, { previousStatus, snapshot, decisionResolved: true });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.control.pauseAll": async ({ params, respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    const enabled = readOptionalBoolean(params, "enabled", respond);
    if (params.enabled !== undefined && enabled === undefined) {
      return;
    }
    try {
      const control = await clawMissionService.pauseAll(enabled ?? true);
      respond(true, { control }, undefined);
      context.broadcast("claw.control.changed", { control }, { dropIfSlow: true });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.control.stopAllNow": async ({ respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    try {
      const control = await clawMissionService.stopAllNow();
      respond(true, { control }, undefined);
      context.broadcast("claw.control.changed", { control }, { dropIfSlow: true });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.control.setAutonomy": async ({ params, respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    if (typeof params.enabled !== "boolean") {
      respondInvalidRequest(respond, "enabled (boolean) is required");
      return;
    }
    try {
      const control = await clawMissionService.setAutonomy(params.enabled);
      respond(true, { control }, undefined);
      context.broadcast("claw.control.changed", { control }, { dropIfSlow: true });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.audit.get": async ({ params, respond }) => {
    const missionId = readRequiredString(params, "missionId", respond);
    const limit = readOptionalPositiveNumber(params, "limit", respond);
    if (!missionId || ("limit" in params && params.limit !== undefined && limit === undefined)) {
      return;
    }
    try {
      respond(
        true,
        { missionId, entries: await clawMissionService.getAudit(missionId, limit) },
        undefined,
      );
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.artifacts.list": async ({ params, respond }) => {
    const missionId = readRequiredString(params, "missionId", respond);
    if (!missionId) {
      return;
    }
    try {
      respond(
        true,
        { missionId, artifacts: await clawMissionService.listArtifacts(missionId) },
        undefined,
      );
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },

  "claw.preflight.rerun": async ({ params, respond, context, client }) => {
    if (!requireAdminScope(client?.connect?.scopes, respond)) {
      return;
    }
    const missionId = readRequiredString(params, "missionId", respond);
    if (!missionId) {
      return;
    }
    try {
      const current = await clawMissionService.getMissionSnapshot(missionId);
      const previousStatus = current.mission?.status ?? null;
      const snapshot = await clawMissionService.rerunPreflight(missionId);
      respond(true, snapshot, undefined);
      broadcastMissionSnapshot(context, { previousStatus, snapshot });
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },
};
