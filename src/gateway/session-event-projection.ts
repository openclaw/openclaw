import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { PrepareSessionEventProjection } from "./server-broadcast-types.js";
import { prepareSessionAncestor } from "./session-ancestor-references.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import type { SessionRowProjection } from "./session-row-projection.js";

/** Bind prepared rows without exposing their implementation to transport contracts. */
export function prepareSessionEventProjection(
  projection: SessionRowProjection,
  read?: SessionRowReadView,
): PrepareSessionEventProjection {
  return (event, payload, eventScope, connection) => {
    if (!connection.isCurrentProjection(projection)) {
      return () => undefined;
    }
    if ((event !== "sessions.changed" && event !== "session.message") || !isRecord(payload)) {
      return undefined;
    }
    const source = payload;
    if (source.reason === "delete" || typeof source.sessionKey !== "string") {
      connection.forgetAncestors(
        typeof source.sessionKey === "string" ? source.sessionKey : undefined,
      );
      return undefined;
    }
    const scope = connection.resolveAgentScope(
      source.sessionKey,
      typeof source.agentId === "string" ? source.agentId : eventScope.agentId,
    );
    if (!scope?.[1] || (!scope[0] && !scope[2] && !parseAgentSessionKey(source.sessionKey))) {
      return undefined;
    }
    const query = { key: source.sessionKey, agentId: scope[1] };
    const rows = read ?? projection;
    const record = rows.describe(query);
    if (
      !record ||
      (typeof source.sessionId === "string" && source.sessionId !== record.entry.sessionId)
    ) {
      return () => undefined;
    }
    const base = isRecord(source.session)
      ? source
      : {
          ...buildGatewaySessionSnapshot({
            sessionRow: rows.present(record),
            agentId: scope[0],
            includeSession: true,
          }),
          ...source,
        };
    const sourceRow = base.session;
    if (
      !isRecord(sourceRow) ||
      sourceRow.sessionId !== record.entry.sessionId ||
      (sourceRow.lifecycleRevision !== undefined &&
        sourceRow.lifecycleRevision !== record.entry.lifecycleRevision)
    ) {
      return () => undefined;
    }
    const presentRecipient = prepareSessionRowPublication(projection, Date.now(), rows);
    const encodedRows = new WeakMap<object, string>();
    const preparedAncestors = new WeakMap<object, ReturnType<typeof prepareSessionAncestor>>();
    const ancestors = projection.ancestorRows(record, read);
    const enrichment = { includeDerivedTitles: true, includeLastMessage: true };
    return (client) => {
      if (!connection.isCurrentProjection(projection) || !projection.isCurrent(record)) {
        return undefined;
      }
      const presentation = presentRecipient(client, connection.getRunProjector());
      const row = presentation.present(record, enrichment);
      if (!row) {
        return undefined;
      }
      const references = connection.references(client);
      const ancestorRows = ancestors?.every((ancestor) => projection.isCurrent(ancestor))
        ? ancestors.flatMap((ancestor) => {
            if (presentation.sharing.entryFilter?.(ancestor.key, ancestor.entry) === false) {
              references.forget(ancestor.key);
              return [];
            }
            const presented = presentation.present(ancestor, enrichment);
            if (!presented) {
              return [];
            }
            let prepared = preparedAncestors.get(presented);
            if (!prepared) {
              prepared = prepareSessionAncestor(presented);
              preparedAncestors.set(presented, prepared);
            }
            return [prepared];
          })
        : undefined;
      const ancestorDelivery = ancestorRows && references.prepare(ancestorRows);
      if (!ancestorDelivery) {
        connection.forgetConnectionAncestors(client);
      }
      const projected: Record<string, unknown> = {
        ...base,
        session: row,
        fastMode: row.fastMode,
        effectiveFastMode: row.effectiveFastMode,
        ancestorSessions: ancestorDelivery?.ancestorSessions,
        ancestorSessionRefs: ancestorDelivery?.ancestorSessionRefs,
        visibility: row.visibility,
        sharingRole: row.sharingRole,
        ...(isRecord(base.activitySummary) && row.activitySummary
          ? {
              activitySummary: {
                ...base.activitySummary,
                canEnsure: row.activitySummary.canEnsure,
              },
            }
          : {}),
      };
      if (Object.hasOwn(projected, "childSessions")) {
        projected.childSessions = row.childSessions;
      }
      return {
        payload: projected,
        serializeSession: () => {
          let encoded = encodedRows.get(row);
          if (encoded === undefined) {
            encoded = JSON.stringify(row);
            encodedRows.set(row, encoded);
          }
          return encoded;
        },
        delivered: () => {
          references.forget(row.key);
          if (event === "sessions.changed" && source.reason === "activity-summary") {
            // Rosters skip recaps, so a full recap row cannot certify a later reference.
            for (const ancestor of ancestorDelivery?.ancestorSessions ?? []) {
              references.forget(ancestor.key);
            }
          } else {
            ancestorDelivery?.delivered();
          }
        },
      };
    };
  };
}
