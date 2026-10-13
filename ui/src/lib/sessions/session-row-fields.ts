import { Check } from "typebox/value";
import {
  expandSessionRowFacts,
  SESSION_ROW_FIELDS,
  SESSION_ROW_PRESETS,
  SessionRowProjectionSchema,
  type ProjectedSessionRow as ProtocolProjectedSessionRow,
  type SessionRowField,
  type SessionRowMode,
  type SessionRowProjection,
} from "../../../../packages/gateway-protocol/src/session-row-fields.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";

export type { SessionRowField };

const presetCoverage: Record<SessionRowMode, ReadonlySet<string>> = {
  compact: new Set(SESSION_ROW_PRESETS.compact),
  dashboard: new Set(SESSION_ROW_PRESETS.dashboard),
  sidebar: new Set(SESSION_ROW_PRESETS.sidebar),
};
const wireFields: ReadonlySet<string> = new Set(SESSION_ROW_FIELDS);

export function readSessionRowProjection(value: unknown): SessionRowProjection | undefined {
  return Check(SessionRowProjectionSchema, value) ? value : undefined;
}

export function sessionRowCoverage(
  row: Pick<GatewaySessionRow, "rowMode" | "rowProjectionId">,
  projection?: SessionRowProjection,
): ReadonlySet<string> | undefined {
  if (row.rowMode === "fields") {
    if (!projection || projection.id !== row.rowProjectionId) {
      throw new Error("The Gateway omitted session field coverage. Refresh to try again.");
    }
    return new Set(projection.fields);
  }
  return row.rowMode ? presetCoverage[row.rowMode] : undefined;
}

export function preserveUncoveredSessionRowFields(
  incoming: GatewaySessionRow,
  previous: GatewaySessionRow | undefined,
  covered: ReadonlySet<string> | undefined,
): GatewaySessionRow {
  if (!covered || !previous?.sessionId || incoming.sessionId !== previous.sessionId) {
    return incoming;
  }
  const next = { ...incoming };
  for (const [field, value] of Object.entries(previous)) {
    if (
      !covered.has(field) &&
      value !== undefined &&
      (wireFields.has(field) || !Object.hasOwn(incoming, field))
    ) {
      Object.assign(next, { [field]: value });
    }
  }
  return next;
}

export type ProjectedSessionRow<Fields extends readonly SessionRowField[]> = Pick<
  GatewaySessionRow,
  keyof ProtocolProjectedSessionRow<Fields>
>;

export type ProjectedSessionListResult<Fields extends readonly SessionRowField[]> = Omit<
  SessionsListResult,
  "sessions"
> & { sessions: ProjectedSessionRow<Fields>[] };

export function canSelectSessionRowFields(hello: GatewayHelloOk | null | undefined): boolean {
  return hello?.features?.capabilities?.includes("sessions.rowFields") === true;
}

export function expandSessionListResult(result: SessionsListResult): SessionsListResult {
  for (const row of result.sessions) {
    if (row.rowMode === "fields" && result.rowProjection?.id !== row.rowProjectionId) {
      throw new Error("The Gateway omitted session field coverage. Refresh to try again.");
    }
  }
  if (!result.sharedFacts) {
    return result;
  }
  const { sharedFacts, ...list } = result;
  return { ...list, sessions: expandSessionRowFacts(list.sessions, sharedFacts) };
}

export function sessionRowFieldsSelection(
  fields: readonly SessionRowField[],
  fallback: "compact" | "dashboard" | "sidebar",
  enabled: boolean,
): { fields: SessionRowField[]; rowMode?: never } | { rowMode: typeof fallback; fields?: never } {
  return enabled ? { fields: [...fields] } : { rowMode: fallback };
}
