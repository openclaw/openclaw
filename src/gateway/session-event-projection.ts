import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import type { PrepareSessionEventProjection } from "./server-broadcast-types.js";
import { prepareSessionAncestor } from "./session-ancestor-references.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { createSessionRowDeltaDiffer } from "./session-row-delta-fields.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { prepareSessionRowPublication, serializeSessionRow } from "./session-row-presentation.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type ProjectedPayload = Record<string, unknown> & {
  session: GatewaySessionRow;
  ancestorSessions?: GatewaySessionRow[];
};

/** Bind prepared rows without exposing their implementation to transport contracts. */
export function prepareSessionEventProjection(
  projection: SessionRowProjection,
  read?: SessionRowReadView,
  prepared?: {
    ancestors: ReturnType<SessionRowProjection["ancestorRows"]>;
    /** The transcript publisher owns the message graph for synchronous fanout. */
    encodeMessage?: true;
    controlUiOnly?: boolean;
  },
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
    // Transcript producers publish one message; only the recipient envelope varies.
    let messageBytes: Buffer | undefined;
    const serializeMessage =
      event === "session.message" && prepared?.encodeMessage
        ? () => {
            if (!messageBytes) {
              const field = JSON.stringify({ message: base.message }).slice(1, -1);
              messageBytes = Buffer.from(field ? `${field},` : "");
            }
            return messageBytes;
          }
        : undefined;
    const presentRecipient = prepareSessionRowPublication(projection, Date.now(), rows);
    const ancestors = prepared ? prepared.ancestors : projection.ancestorRows(record, read);
    const enrichment = { includeDerivedTitles: true, includeLastMessage: true };
    const ancestorRevision = randomUUID();
    const audiences = new Map<
      string,
      {
        row: NonNullable<ReturnType<ReturnType<typeof presentRecipient>["present"]>>;
        ancestors: ReturnType<typeof prepareSessionAncestor>[] | undefined;
        hiddenAncestors: string[];
        payloads: Map<string | undefined, ProjectedPayload>;
      }
    >();
    const diff = createSessionRowDeltaDiffer();
    const deltaPayloads = new WeakMap<object, Map<string, Record<string, unknown>>>();
    const baselineIds = new WeakMap<object, number>();
    let nextBaselineId = 0;
    const baselineId = (baseline: object | undefined) => {
      if (!baseline) {
        return 0;
      }
      let id = baselineIds.get(baseline);
      if (id === undefined) {
        id = ++nextBaselineId;
        baselineIds.set(baseline, id);
      }
      return id;
    };
    let revision = projection.state.revision;
    let accessRevision = readGatewayAccessRevision();
    // Run display facts belong to this synchronous publication; recipient authority stays live.
    const runProjector = connection.createRunProjector();
    return (client) => {
      // Check before audience payload/encoding caches: equal sharing scopes do not imply equal UI.
      if (prepared?.controlUiOnly && client.connect.client.id !== GATEWAY_CLIENT_IDS.CONTROL_UI) {
        return undefined;
      }
      if (!connection.isCurrentProjection(projection) || !projection.isCurrent(record)) {
        return undefined;
      }
      const currentAccessRevision = readGatewayAccessRevision();
      if (revision !== projection.state.revision || accessRevision !== currentAccessRevision) {
        audiences.clear();
        revision = projection.state.revision;
        accessRevision = currentAccessRevision;
      }
      // Resolve each recipient's live authority before reusing this synchronous publication.
      const presentation = presentRecipient(client, runProjector);
      const audienceKey = presentation.audienceKey;
      let audience = audiences.get(audienceKey);
      if (!audience) {
        const row = presentation.present(record, enrichment);
        if (!row) {
          return undefined;
        }
        const hiddenAncestors: string[] = [];
        const ancestorRows = ancestors?.every((ancestor) => projection.isCurrent(ancestor))
          ? ancestors.flatMap((ancestor) => {
              if (presentation.sharing.entryFilter?.(ancestor.key, ancestor.entry) === false) {
                hiddenAncestors.push(ancestor.key);
                return [];
              }
              const presented = presentation.present(ancestor, enrichment);
              return presented ? [prepareSessionAncestor(presented)] : [];
            })
          : undefined;
        audience = { row, ancestors: ancestorRows, hiddenAncestors, payloads: new Map() };
        audiences.set(audienceKey, audience);
      }
      const { row } = audience;
      const references = connection.references(client);
      if (audience.hiddenAncestors.length) {
        references.clearRows();
      }
      for (const key of audience.hiddenAncestors) {
        references.forget(key);
      }
      const ancestorDelivery =
        audience.ancestors && references.prepare(audience.ancestors, ancestorRevision);
      if (!ancestorDelivery) {
        connection.forgetConnectionAncestors(client);
      }
      const deliveryKey = ancestorDelivery?.deliveryKey;
      let projected = audience.payloads.get(deliveryKey);
      if (!projected) {
        projected = {
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
        audience.payloads.set(deliveryKey, projected);
      }
      const rowDelivery = hasGatewayClientCap(
        client.connect.caps,
        GATEWAY_CLIENT_CAPS.SESSION_ROW_DELTAS,
      )
        ? references.prepareRows([row, ...(projected.ancestorSessions ?? [])], diff)
        : undefined;
      let wirePayload: Record<string, unknown> = projected;
      if (rowDelivery) {
        const cacheKey = JSON.stringify([rowDelivery.key, rowDelivery.bases.map(baselineId)]);
        let cached = deltaPayloads.get(projected);
        if (!cached) {
          cached = new Map();
          deltaPayloads.set(projected, cached);
        }
        let deltaPayload = cached.get(cacheKey);
        if (!deltaPayload) {
          deltaPayload = {
            ...projected,
            session: rowDelivery.wire[0],
            ...(Array.isArray(projected.ancestorSessions)
              ? { ancestorSessions: rowDelivery.wire.slice(1) }
              : {}),
          };
          cached.set(cacheKey, deltaPayload);
        }
        wirePayload = deltaPayload;
      }
      return {
        payload: wirePayload,
        serializeSession: () =>
          rowDelivery ? JSON.stringify(rowDelivery.wire[0]) : serializeSessionRow(row),
        serializeMessage,
        delivered: () => {
          rowDelivery?.delivered();
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
