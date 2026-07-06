// Metadata-only operator audit queries over the canonical shared SQLite ledger.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type AuditEvent,
  validateAuditListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAuditEvents } from "../../audit/audit-event-store.js";
import type { AuditEventRecord } from "../../audit/audit-event-types.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_AUDIT_LIST_LIMIT = 100;
const MAX_AUDIT_LIST_LIMIT = 500;

function parseAuditCursor(cursor: string | undefined): number | undefined | null {
  if (cursor === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(cursor)) {
    return null;
  }
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function mapAuditEvent(event: AuditEventRecord): AuditEvent {
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    sourceSequence: event.sourceSequence,
    occurredAt: event.occurredAt,
    kind: event.kind,
    action: event.action,
    status: event.status,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    actor: { type: event.actorType, id: event.actorId },
    agentId: event.agentId,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    runId: event.runId,
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    redaction: "metadata_only",
  };
}

export const auditHandlers: GatewayRequestHandlers = {
  "audit.list": ({ params, respond }) => {
    if (!validateAuditListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid audit.list params: ${formatValidationErrors(validateAuditListParams.errors)}`,
        ),
      );
      return;
    }
    const cursor = parseAuditCursor(params.cursor);
    if (
      cursor === null ||
      (params.after !== undefined && params.before !== undefined && params.after > params.before)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid audit.list range or cursor"),
      );
      return;
    }
    const page = listAuditEvents({
      limit: Math.min(params.limit ?? DEFAULT_AUDIT_LIST_LIMIT, MAX_AUDIT_LIST_LIMIT),
      ...(cursor !== undefined ? { cursor } : {}),
      filters: {
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.after !== undefined ? { after: params.after } : {}),
        ...(params.before !== undefined ? { before: params.before } : {}),
      },
    });
    respond(true, {
      events: page.events.map(mapAuditEvent),
      ...(page.nextCursor !== undefined ? { nextCursor: String(page.nextCursor) } : {}),
    });
  },
};

export const testApi = { mapAuditEvent, parseAuditCursor };
