import { Type, type TProperties } from "typebox";
import {
  CronAddJobResultSchema,
  CronAddResultSchema,
  CronDeliveryPreviewSchema,
  CronJobSchema,
  CronRunLogEntrySchema,
} from "../../../packages/gateway-protocol/src/schema/cron.js";
import { defineToolOutputSchema } from "../schema/tool-output-schema.js";

function closedObject<T extends TProperties>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const job = CronJobSchema.properties;

// The Gateway's compact projection omits payloads and event commands. Older
// protocol-v4 Gateways return full jobs after the tool's compact fallback.
const CompactCronJobSchema = closedObject({
  id: job.id,
  name: job.name,
  agentId: job.agentId,
  // Protocol-v4 compact replies from older Gateways omit the update timestamp.
  updatedAtMs: Type.Optional(job.updatedAtMs),
  declarationKey: job.declarationKey,
  displayName: job.displayName,
  owner: job.owner,
  enabled: job.enabled,
  effectiveAgentId: Type.Optional(nullableString),
  nextRunAt: nullableString,
  nextRunAtMs: nullableNumber,
  scheduleKind: Type.Union([
    Type.Literal("at"),
    Type.Literal("every"),
    Type.Literal("cron"),
    Type.Literal("on-exit"),
    Type.Literal("stream"),
    Type.Literal("event"),
  ]),
  schedule: Type.Optional(
    Type.Union(
      job.schedule.anyOf.filter((schema) =>
        ["at", "every", "cron"].includes(schema.properties.kind.const),
      ),
    ),
  ),
  trigger: Type.Optional(Type.Literal(true)),
  lastRunAt: nullableString,
  lastRunAtMs: nullableNumber,
  lastRunStatus: Type.Union([...job.lastRunStatus.anyOf, Type.Null()]),
  lastRunError: nullableString,
  runningAtMs: job.state.properties.runningAtMs,
  autoDisabled: job.state.properties.autoDisabled,
  lastDelivered: job.lastDelivered,
  lastDeliveryStatus: job.lastDeliveryStatus,
  lastDeliveryError: job.lastDeliveryError,
  deliverySuppressionReason: job.deliverySuppressionReason,
  lastFailureNotificationDelivered: job.lastFailureNotificationDelivered,
  lastFailureNotificationDeliveryStatus: job.lastFailureNotificationDeliveryStatus,
  lastFailureNotificationDeliveryError: job.lastFailureNotificationDeliveryError,
});

const FullCronListJobSchema = closedObject({
  ...job,
  effectiveAgentId: Type.Optional(nullableString),
});

const page = {
  total: Type.Integer({ minimum: 0 }),
  offset: Type.Integer({ minimum: 0 }),
  limit: Type.Integer({ minimum: 0 }),
  hasMore: Type.Boolean(),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
};

const CronListOutputSchema = closedObject({
  jobs: Type.Array(Type.Union([CompactCronJobSchema, FullCronListJobSchema])),
  ...page,
  // Self-scoped inventories intentionally remove the global snapshot token.
  snapshotRevision: Type.Optional(Type.String()),
  scope: Type.Optional(Type.Union([Type.Literal("caller"), Type.Literal("gateway")])),
  scopeHint: Type.Optional(Type.String()),
  deliveryPreviews: Type.Optional(
    Type.Object({}, { additionalProperties: CronDeliveryPreviewSchema }),
  ),
});

const CronStatusOutputSchema = closedObject({
  enabled: Type.Boolean(),
  // Restricted automation runs receive only enabled; ordinary status includes
  // these scheduler-owned fields (older Gateways may omit newer fields).
  triggersEnabled: Type.Optional(Type.Boolean()),
  storePath: Type.Optional(Type.String()),
  storage: Type.Optional(Type.Literal("sqlite")),
  sqlitePath: Type.Optional(Type.String()),
  jobs: Type.Optional(Type.Integer({ minimum: 0 })),
  nextWakeAtMs: Type.Optional(nullableNumber),
});

const runEntry = CronRunLogEntrySchema.properties;
const processInstanceId = Type.Optional(Type.String());
const CronRunOutputSchema = Type.Union([
  closedObject({ ok: Type.Literal(false), processInstanceId }),
  closedObject({ ok: Type.Literal(true), ran: Type.Literal(true), processInstanceId }),
  closedObject({
    ok: Type.Literal(true),
    enqueued: Type.Literal(true),
    runId: Type.String(),
    processInstanceId,
    // The full history entry stays in the result; declare only the outcome fields so the
    // generated action declarations stay within their shared size allowance.
    run: Type.Optional(
      Type.Object(
        {
          runId: runEntry.runId,
          status: runEntry.status,
          completionStatus: runEntry.completionStatus,
          error: runEntry.error,
          summary: runEntry.summary,
          deliveryStatus: runEntry.deliveryStatus,
          deliveryError: runEntry.deliveryError,
          durationMs: runEntry.durationMs,
        },
        { additionalProperties: true },
      ),
    ),
    finished: Type.Optional(Type.Literal(true)),
    note: Type.Optional(Type.String()),
  }),
  closedObject({
    ok: Type.Literal(true),
    ran: Type.Literal(false),
    reason: Type.Union([
      Type.Literal("disabled"),
      Type.Literal("not-due"),
      Type.Literal("already-running"),
      Type.Literal("invalid-spec"),
      Type.Literal("stopped"),
      Type.Literal("ownerless"),
    ]),
    processInstanceId,
  }),
]);

/** Every non-throwing automations result, reusing the canonical job/history contracts. */
export const CronToolOutputSchema = defineToolOutputSchema({
  inputProperty: "action",
  variants: {
    status: CronStatusOutputSchema,
    list: CronListOutputSchema,
    get: CronJobSchema,
    // Add can return a direct job or the declarative convergence envelope.
    add: CronAddResultSchema,
    update: CronAddJobResultSchema,
    remove: Type.Union([
      closedObject({
        ok: Type.Literal(true),
        removed: Type.Boolean(),
        activeRunCancellationRequested: Type.Optional(Type.Literal(true)),
        sessionCleanup: Type.Optional(Type.Literal("pending")),
      }),
      closedObject({ ok: Type.Literal(false), removed: Type.Literal(false) }),
    ]),
    run: CronRunOutputSchema,
    runs: closedObject({ entries: Type.Array(CronRunLogEntrySchema), ...page }),
    next_check: closedObject({
      ok: Type.Literal(true),
      delayMs: Type.Number({ exclusiveMinimum: 0 }),
    }),
    wake: Type.Union([
      closedObject({ ok: Type.Literal(true) }),
      closedObject({
        ok: Type.Literal(false),
        reason: Type.Optional(Type.Literal("unwakeable-session-key")),
      }),
    ]),
  },
});
