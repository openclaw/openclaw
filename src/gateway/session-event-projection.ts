import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import type {
  PrepareSessionEventProjection,
  SessionEventProjection,
} from "./server-broadcast-types.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import {
  prepareSessionAncestor,
  type ConnectionSessionRows,
} from "./session-ancestor-references.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import {
  createSessionRowDeltaDiffer,
  prepareSessionRowDeltaFields,
} from "./session-row-delta-fields.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { serializeSessionRow } from "./session-row-serialization.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type PublicationEnvelope = {
  payload: Record<string, unknown>;
  plan: ReturnType<ConnectionSessionRows["prepareDelivery"]>;
  variants: Array<
    | {
        payload: Record<string, unknown>;
        serialize?: ReturnType<typeof prepareEnvelopeSerialization>;
      }
    | undefined
  >;
  fieldRefs?: { indices: number[]; omitted: Uint8Array };
};

type PublicationDelivery = {
  variants: Array<SessionEventProjection | undefined>;
  envelope: PublicationEnvelope;
  plan: ReturnType<ConnectionSessionRows["prepareDelivery"]>;
  serializeSession: () => string;
  delivered: (client: GatewayClient) => void;
};

/** Stable producer fields retain their order around the two history-owned ancestor fields. */
function prepareEnvelopeSerialization(
  payload: Record<string, unknown>,
  separateMessage: boolean,
  fields: [string, unknown][],
  hasAncestors: boolean,
) {
  const segments: Array<{ prefix: string; field: "ancestorSessions" | "ancestorSessionRefs" }> = [];
  const entries: [string, unknown][] = [];
  const flush = () => {
    const encoded = JSON.stringify(Object.fromEntries(entries)).slice(1, -1);
    entries.length = 0;
    return encoded ? `${encoded},` : "";
  };
  let prefix = ',"payload":{';
  for (const field of Object.keys(payload)) {
    if (field === "session" || (field === "message" && separateMessage)) {
      continue;
    }
    if (hasAncestors && (field === "ancestorSessions" || field === "ancestorSessionRefs")) {
      segments.push({ prefix: prefix + flush(), field });
      prefix = "";
    } else {
      const entry = (fields[entries.length] ??= [field, undefined]);
      entry[0] = field;
      entry[1] = payload[field];
      entries.push(entry);
    }
  }
  const suffix = prefix + flush();
  return (
    recipient: Record<string, unknown>,
    serializeSession: () => string,
    serializeMessage?: () => Buffer,
  ): ReturnType<NonNullable<SessionEventProjection["serializePayload"]>> => {
    let encoded = "";
    for (const segment of segments) {
      const field = JSON.stringify({ [segment.field]: recipient[segment.field] }).slice(1, -1);
      encoded += segment.prefix + (field ? `${field},` : "");
    }
    encoded += suffix;
    const session = `"session":${serializeSession()}}`;
    return serializeMessage
      ? [Buffer.from(encoded), serializeMessage(), Buffer.from(session)]
      : [Buffer.from(encoded + session)];
  };
}

/** Bind prepared rows without exposing their implementation to transport contracts. */
export function prepareSessionEventProjection(
  projection: SessionRowProjection,
  read?: SessionRowReadView,
  prepared?: {
    ancestors: ReturnType<SessionRowProjection["ancestorRows"]>;
    /** The transcript publisher owns the message graph for synchronous fanout. */
    encodeMessage?: true;
    /** The producer owns a plain envelope with stable fields throughout synchronous fanout. */
    reuseEnvelope?: true;
    /** Rechecked per recipient after row projection; exact interest always wins. */
    omitMessage?: (client: GatewayClient) => boolean;
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
        row: GatewaySessionRow;
        rowFields?: string[];
        rowFieldIndices?: Map<string, number>;
        envelope?: PublicationEnvelope;
        ancestors: ReturnType<typeof prepareSessionAncestor>[] | undefined;
        hiddenAncestors: Array<{ key: string; histories: Map<object, object> }>;
        ancestorInvalidations: Map<object, object> | undefined;
        deliveries: [WeakMap<object, PublicationDelivery>, WeakMap<object, PublicationDelivery>];
      }
    >();
    const diff = createSessionRowDeltaDiffer();
    const envelopeFields: [string, unknown][] = [];
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
      const recipient = presentRecipient(client, runProjector);
      const audienceKey = recipient.getAudienceKey();
      let audience = audiences.get(audienceKey);
      if (!audience) {
        const presentation = recipient.getPresentation();
        const row = presentation.present(record, enrichment);
        if (!row) {
          return undefined;
        }
        const hiddenAncestors: Array<{ key: string; histories: Map<object, object> }> = [];
        const ancestorRows = ancestors?.every((ancestor) => projection.isCurrent(ancestor))
          ? ancestors.flatMap((ancestor) => {
              const target = presentation.target({
                key: ancestor.key,
                agentId: ancestor.agentId,
                storePath: ancestor.storeTarget.storePath,
              });
              if (!target || !presentation.sharing.canReadTarget(target)) {
                hiddenAncestors.push({ key: ancestor.key, histories: new Map() });
                return [];
              }
              const presented = presentation.present(ancestor, enrichment);
              return presented ? [prepareSessionAncestor(presented)] : [];
            })
          : undefined;
        audience = {
          row,
          ancestors: ancestorRows,
          hiddenAncestors,
          ancestorInvalidations: ancestorRows ? undefined : new Map(),
          deliveries: [new WeakMap(), new WeakMap()],
        };
        audiences.set(audienceKey, audience);
      }
      const rowDeltas = hasGatewayClientCap(
        client.connect.caps,
        GATEWAY_CLIENT_CAPS.SESSION_ROW_DELTAS,
      );
      const references = connection.references(client);
      for (const hidden of audience.hiddenAncestors) {
        references.forget(hidden.key, hidden.histories);
      }
      if (!audience.ancestors) {
        references.clearAncestors(audience.ancestorInvalidations);
      }
      const deliveries = audience.deliveries[rowDeltas ? 1 : 0];
      let delivery = deliveries.get(references.history);
      if (!delivery) {
        const { row } = audience;
        if (rowDeltas) {
          prepareSessionRowDeltaFields(row, record.materialized.row);
        }
        const plan = references.prepareDelivery(
          row,
          audience.ancestors,
          ancestorRevision,
          rowDeltas ? diff : undefined,
          // Rosters skip recaps, so a full recap row cannot certify a later reference.
          event !== "sessions.changed" || source.reason !== "activity-summary",
        );
        const envelope: PublicationEnvelope = audience.envelope ?? {
          variants: [],
          plan,
          payload: {
            ...base,
            session: plan.rows ? plan.rows.wire[0] : row,
            cyberAccessProgram: row.cyberAccessProgram ?? null,
            fastMode: row.fastMode,
            effectiveFastMode: row.effectiveFastMode,
            ancestorSessions: plan.ancestor
              ? plan.rows
                ? plan.rows.wire.slice(1)
                : plan.ancestor.ancestorSessions
              : undefined,
            ancestorSessionRefs: plan.ancestor?.ancestorSessionRefs,
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
          },
        };
        if (Object.hasOwn(envelope.payload, "childSessions")) {
          envelope.payload.childSessions = row.childSessions;
        }
        if (prepared?.reuseEnvelope) {
          audience.envelope = envelope;
        }
        let sessionJSON = plan.rows?.encoded[0];
        delivery = {
          variants: [],
          envelope,
          plan,
          serializeSession: () =>
            (sessionJSON ??= plan.rows
              ? JSON.stringify(plan.rows.wire[0])
              : serializeSessionRow(row)),
          delivered: (viewer) => connection.references(viewer).deliver(plan),
        };
        deliveries.set(references.history, delivery);
      }
      const fieldRefs =
        rowDeltas &&
        hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.SESSION_EVENT_FIELD_REFS);
      const omitMessage = event === "session.message" && prepared?.omitMessage?.(client);
      const variant = Number(fieldRefs) + (omitMessage ? 2 : 0);
      let projected = delivery.variants[variant];
      if (!projected) {
        const { row } = audience;
        const envelope = delivery.envelope;
        let template = envelope.variants[variant];
        const reused = template !== undefined;
        if (!template) {
          let refs = fieldRefs ? envelope.fieldRefs : undefined;
          if (fieldRefs && !refs) {
            // Names index the immutable full row; values need no per-audience entry tuples.
            const fields = (audience.rowFields ??= Object.keys(row)
              .filter((field) => Reflect.get(row, field) !== undefined)
              // oxlint-disable-next-line unicorn/no-array-sort -- The filtered array is private to this audience.
              .sort());
            if (!audience.rowFieldIndices) {
              audience.rowFieldIndices = new Map();
              for (let index = 0; index < fields.length; index++) {
                audience.rowFieldIndices.set(fields[index]!, index);
              }
            }
            refs = { indices: [], omitted: new Uint8Array(fields.length) };
            for (let index = 0; index < fields.length; index++) {
              const field = fields[index]!;
              if (
                field !== "key" &&
                field !== "agentId" &&
                Object.hasOwn(envelope.payload, field) &&
                isDeepStrictEqual(envelope.payload[field], Reflect.get(row, field))
              ) {
                refs.indices.push(index);
                refs.omitted[index] = 1;
              }
            }
            envelope.fieldRefs = refs;
          }
          let wirePayload = envelope.payload;
          if (refs || omitMessage) {
            // fromEntries consumes these scratch tuples synchronously; only the envelope escapes.
            let count = 0;
            const keys = Object.keys(envelope.payload);
            // oxlint-disable-next-line typescript/prefer-for-of -- Keep the measured indexed traversal in this hot path.
            for (let i = 0; i < keys.length; i++) {
              const field = keys[i]!;
              if (
                (omitMessage && field === "message") ||
                refs?.omitted[audience.rowFieldIndices!.get(field) ?? -1]
              ) {
                continue;
              }
              const entry = (envelopeFields[count++] ??= [field, undefined]);
              entry[0] = field;
              entry[1] = envelope.payload[field];
            }
            envelopeFields.length = count;
            wirePayload = Object.fromEntries(envelopeFields);
            if (refs) {
              wirePayload.sessionFieldRefs = refs.indices;
            }
          }
          template = { payload: wirePayload };
          envelope.variants[variant] = template;
        }
        const plan = delivery.plan;
        // Templates never carry one connection's row versions or ancestor certificates to another.
        const wirePayload =
          prepared?.reuseEnvelope && envelope.plan !== plan
            ? {
                ...template.payload,
                session: plan.rows ? plan.rows.wire[0] : row,
                ancestorSessions: plan.ancestor
                  ? plan.rows
                    ? plan.rows.wire.slice(1)
                    : plan.ancestor.ancestorSessions
                  : undefined,
                ancestorSessionRefs: plan.ancestor?.ancestorSessionRefs,
              }
            : template.payload;
        const message = omitMessage ? undefined : serializeMessage;
        // A singleton uses the ordinary encoder; prepare shared fragments only on actual reuse.
        const serialize =
          prepared?.reuseEnvelope && reused
            ? (template.serialize ??= prepareEnvelopeSerialization(
                template.payload,
                Boolean(message),
                envelopeFields,
                Boolean(audience.ancestors?.length),
              ))
            : undefined;
        const serializeSession = delivery.serializeSession;
        projected = {
          payload: wirePayload,
          serializeSession,
          serializeMessage: message,
          serializePayload: serialize
            ? () => serialize(wirePayload, serializeSession, message)
            : undefined,
          delivered: delivery.delivered,
        };
        delivery.variants[variant] = projected;
      }
      return projected;
    };
  };
}
