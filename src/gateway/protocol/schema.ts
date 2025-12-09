import { Type, type Static, type TSchema } from "@sinclair/typebox";

const NonEmptyString = Type.String({ minLength: 1 });

export const PresenceEntrySchema = Type.Object(
  {
    host: Type.Optional(NonEmptyString),
    ip: Type.Optional(NonEmptyString),
    version: Type.Optional(NonEmptyString),
    mode: Type.Optional(NonEmptyString),
    lastInputSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    reason: Type.Optional(NonEmptyString),
    tags: Type.Optional(Type.Array(NonEmptyString)),
    text: Type.Optional(Type.String()),
    ts: Type.Integer({ minimum: 0 }),
    instanceId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const HealthSnapshotSchema = Type.Any();

export const StateVersionSchema = Type.Object(
  {
    presence: Type.Integer({ minimum: 0 }),
    health: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SnapshotSchema = Type.Object(
  {
    presence: Type.Array(PresenceEntrySchema),
    health: HealthSnapshotSchema,
    stateVersion: StateVersionSchema,
    uptimeMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const HelloSchema = Type.Object(
  {
    type: Type.Literal("hello"),
    minProtocol: Type.Integer({ minimum: 1 }),
    maxProtocol: Type.Integer({ minimum: 1 }),
    client: Type.Object(
      {
        name: NonEmptyString,
        version: NonEmptyString,
        platform: NonEmptyString,
        mode: NonEmptyString,
        instanceId: Type.Optional(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    caps: Type.Optional(Type.Array(NonEmptyString, { default: [] })),
    auth: Type.Optional(
      Type.Object(
        {
          token: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    locale: Type.Optional(Type.String()),
    userAgent: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const HelloOkSchema = Type.Object(
  {
    type: Type.Literal("hello-ok"),
    protocol: Type.Integer({ minimum: 1 }),
    server: Type.Object(
      {
        version: NonEmptyString,
        commit: Type.Optional(NonEmptyString),
        host: Type.Optional(NonEmptyString),
        connId: NonEmptyString,
      },
      { additionalProperties: false },
    ),
    features: Type.Object(
      {
        methods: Type.Array(NonEmptyString),
        events: Type.Array(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    snapshot: SnapshotSchema,
    policy: Type.Object(
      {
        maxPayload: Type.Integer({ minimum: 1 }),
        maxBufferedBytes: Type.Integer({ minimum: 1 }),
        tickIntervalMs: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const HelloErrorSchema = Type.Object(
  {
    type: Type.Literal("hello-error"),
    reason: NonEmptyString,
    expectedProtocol: Type.Optional(Type.Integer({ minimum: 1 })),
    minClient: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ErrorShapeSchema = Type.Object(
  {
    code: NonEmptyString,
    message: NonEmptyString,
    details: Type.Optional(Type.Unknown()),
    retryable: Type.Optional(Type.Boolean()),
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const RequestFrameSchema = Type.Object(
  {
    type: Type.Literal("req"),
    id: NonEmptyString,
    method: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: NonEmptyString,
    ok: Type.Boolean(),
    payload: Type.Optional(Type.Unknown()),
    error: Type.Optional(ErrorShapeSchema),
  },
  { additionalProperties: false },
);

export const EventFrameSchema = Type.Object(
  {
    type: Type.Literal("event"),
    event: NonEmptyString,
    payload: Type.Optional(Type.Unknown()),
    seq: Type.Optional(Type.Integer({ minimum: 0 })),
    stateVersion: Type.Optional(StateVersionSchema),
  },
  { additionalProperties: false },
);

export const AgentEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    stream: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export const SendParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    message: NonEmptyString,
    mediaUrl: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentParamsSchema = Type.Object(
  {
    message: NonEmptyString,
    to: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    timeout: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ProtocolSchemas: Record<string, TSchema> = {
  Hello: HelloSchema,
  HelloOk: HelloOkSchema,
  HelloError: HelloErrorSchema,
  RequestFrame: RequestFrameSchema,
  ResponseFrame: ResponseFrameSchema,
  EventFrame: EventFrameSchema,
  PresenceEntry: PresenceEntrySchema,
  StateVersion: StateVersionSchema,
  Snapshot: SnapshotSchema,
  ErrorShape: ErrorShapeSchema,
  AgentEvent: AgentEventSchema,
  SendParams: SendParamsSchema,
  AgentParams: AgentParamsSchema,
};

export type Hello = Static<typeof HelloSchema>;
export type HelloOk = Static<typeof HelloOkSchema>;
export type HelloError = Static<typeof HelloErrorSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
export type Snapshot = Static<typeof SnapshotSchema>;
export type PresenceEntry = Static<typeof PresenceEntrySchema>;
export type ErrorShape = Static<typeof ErrorShapeSchema>;
export type StateVersion = Static<typeof StateVersionSchema>;
export type AgentEvent = Static<typeof AgentEventSchema>;

export const ErrorCodes = {
  NOT_LINKED: "NOT_LINKED",
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export function errorShape(
  code: ErrorCode,
  message: string,
  opts?: { details?: unknown; retryable?: boolean; retryAfterMs?: number },
): ErrorShape {
  return {
    code,
    message,
    ...opts,
  };
}
