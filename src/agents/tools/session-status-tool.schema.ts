import { Type, type Static } from "typebox";

export const SessionStatusToolSchema = Type.Object({
  user: Type.Optional(
    Type.String({
      description:
        "The person's requester_profile.id, required when several people have steered this turn.",
    }),
  ),
  sessionKey: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  changesSince: Type.Optional(Type.Integer({ minimum: 0 })),
});

const SessionStatusOriginSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

const SessionStatusDeliveryContextSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

const SessionStatusStateEventPayloadSchema = Type.Object(
  {
    outcome: Type.Optional(
      Type.Union([Type.Literal("error"), Type.Literal("timeout"), Type.Literal("cancelled")]),
    ),
    channel: Type.Optional(Type.String()),
    turns: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const SessionStatusStateEventSchema = Type.Object(
  {
    sequence: Type.Integer(),
    kind: Type.String(),
    actorType: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
    occurredAt: Type.Number(),
    summary: Type.String(),
    actorId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    payload: Type.Optional(SessionStatusStateEventPayloadSchema),
  },
  { additionalProperties: false },
);

export const SessionStatusOutputSchema = Type.Object(
  {
    ok: Type.Literal(true),
    sessionKey: Type.String(),
    agentId: Type.String(),
    changedModel: Type.Boolean(),
    stateVersion: Type.Integer(),
    statusText: Type.String(),
    stateChanges: Type.Optional(
      Type.Object(
        {
          events: Type.Array(SessionStatusStateEventSchema),
          truncated: Type.Boolean(),
          earliestAvailableSequence: Type.Integer(),
          historyGap: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    model: Type.Optional(Type.String()),
    modelProvider: Type.Optional(Type.String()),
    modelOverride: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    origin: Type.Optional(SessionStatusOriginSchema),
    active: Type.Optional(SessionStatusDeliveryContextSchema),
    deliveryContext: Type.Optional(SessionStatusDeliveryContextSchema),
  },
  { additionalProperties: false },
);

export type SessionStatusOriginDetails = Static<typeof SessionStatusOriginSchema>;
export type SessionStatusDeliveryContextDetails = Static<typeof SessionStatusDeliveryContextSchema>;
