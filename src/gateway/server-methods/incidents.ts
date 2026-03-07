import type { GatewayIncidentStatusFilter } from "../incident-manager.js";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { broadcastDashboardDelta } from "./dashboard.js";

function isIncidentStatusFilter(value: string): value is GatewayIncidentStatusFilter {
  return (
    value === "active" ||
    value === "all" ||
    value === "open" ||
    value === "acked" ||
    value === "resolved"
  );
}

function resolveActor(
  client: { connect?: { client?: { displayName?: string; id?: string } } } | null,
) {
  const displayName = client?.connect?.client?.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const clientId = client?.connect?.client?.id?.trim();
  return clientId || null;
}

export const incidentsHandlers: GatewayRequestHandlers = {
  "incident.list": async ({ params, respond, context }) => {
    const status =
      typeof params.status === "string" && params.status.trim()
        ? params.status.trim().toLowerCase()
        : "active";
    if (!isIncidentStatusFilter(status)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid status"));
      return;
    }
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
        ? Math.floor(params.limit)
        : 50;
    const incidents =
      context.incidentManager?.list({
        status,
        limit,
      }) ?? [];
    const summary = context.incidentManager?.summarize() ?? {
      active: 0,
      open: 0,
      acked: 0,
      resolved: 0,
      critical: 0,
      warn: 0,
      info: 0,
    };
    respond(true, { summary, incidents }, undefined);
  },
  "incident.ack": async ({ params, respond, context, client }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    const record = context.incidentManager?.ack(id, resolveActor(client)) ?? null;
    if (!record) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown incident id"));
      return;
    }
    await broadcastDashboardDelta(context);
    respond(true, { ok: true, incident: record }, undefined);
  },
  "incident.resolve": async ({ params, respond, context, client }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    const record = context.incidentManager?.resolve(id, resolveActor(client)) ?? null;
    if (!record) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown incident id"));
      return;
    }
    await broadcastDashboardDelta(context);
    respond(true, { ok: true, incident: record }, undefined);
  },
};
