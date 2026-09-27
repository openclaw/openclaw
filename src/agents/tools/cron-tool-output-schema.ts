import { Type } from "typebox";
import {
  CronAddResultSchema,
  CronDeliveryPreviewSchema,
  CronJobSchema,
  CronRunLogEntrySchema,
} from "../../../packages/gateway-protocol/src/schema/cron.js";
import { defineToolOutputSchema } from "../schema/tool-output-schema.js";

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const job = CronJobSchema.properties;

// The Gateway's compact projection omits payloads and event commands. Older
// protocol-v4 Gateways return full jobs after the tool's compact fallback.
const CompactCronJobSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

const FullCronListJobSchema = Type.Object(
  { ...job, effectiveAgentId: Type.Optional(nullableString) },
  { additionalProperties: false },
);

const page = {
  total: Type.Integer({ minimum: 0 }),
  offset: Type.Integer({ minimum: 0 }),
  limit: Type.Integer({ minimum: 0 }),
  hasMore: Type.Boolean(),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
};

const CronListOutputSchema = Type.Object(
  {
    jobs: Type.Array(Type.Union([CompactCronJobSchema, FullCronListJobSchema])),
    ...page,
    // Self-scoped inventories intentionally remove the global snapshot token.
    snapshotRevision: Type.Optional(Type.String()),
    scope: Type.Optional(Type.Union([Type.Literal("caller"), Type.Literal("gateway")])),
    scopeHint: Type.Optional(Type.String()),
    deliveryPreviews: Type.Optional(
      Type.Object({}, { additionalProperties: CronDeliveryPreviewSchema }),
    ),
  },
  { additionalProperties: false },
);

const CronStatusOutputSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    // Restricted automation runs receive only enabled; ordinary status includes
    // these scheduler-owned fields (older Gateways may omit newer fields).
    triggersEnabled: Type.Optional(Type.Boolean()),
    storePath: Type.Optional(Type.String()),
    storage: Type.Optional(Type.Literal("sqlite")),
    sqlitePath: Type.Optional(Type.String()),
    jobs: Type.Optional(Type.Integer({ minimum: 0 })),
    nextWakeAtMs: Type.Optional(nullableNumber),
  },
  { additionalProperties: false },
);

const processInstanceId = Type.Optional(Type.String());
const CronRunOutputSchema = Type.Union([
  Type.Object({ ok: Type.Literal(false), processInstanceId }, { additionalProperties: false }),
  Type.Object(
    { ok: Type.Literal(true), ran: Type.Literal(true), processInstanceId },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ok: Type.Literal(true),
      enqueued: Type.Literal(true),
      runId: Type.String(),
      processInstanceId,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
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
    },
    { additionalProperties: false },
  ),
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
    update: CronJobSchema,
    remove: Type.Union([
      Type.Object(
        {
          ok: Type.Literal(true),
          removed: Type.Boolean(),
          sessionCleanup: Type.Optional(Type.Literal("pending")),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { ok: Type.Literal(false), removed: Type.Literal(false) },
        { additionalProperties: false },
      ),
    ]),
    run: CronRunOutputSchema,
    runs: Type.Object(
      { entries: Type.Array(CronRunLogEntrySchema), ...page },
      { additionalProperties: false },
    ),
    next_check: Type.Object(
      { ok: Type.Literal(true), delayMs: Type.Number({ exclusiveMinimum: 0 }) },
      { additionalProperties: false },
    ),
    wake: Type.Union([
      Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false }),
      Type.Object(
        { ok: Type.Literal(false), reason: Type.Optional(Type.Literal("unwakeable-session-key")) },
        { additionalProperties: false },
      ),
    ]),
  },
});
