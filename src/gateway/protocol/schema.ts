import { type Static, type TSchema, Type } from "@sinclair/typebox";

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

export const TickEventSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ShutdownEventSchema = Type.Object(
  {
    reason: NonEmptyString,
    restartExpectedMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ConnectParamsSchema = Type.Object(
  {
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

// Discriminated union of all top-level frames. Using a discriminator makes
// downstream codegen (quicktype) produce tighter types instead of all-optional
// blobs.
export const GatewayFrameSchema = Type.Union(
  [RequestFrameSchema, ResponseFrameSchema, EventFrameSchema],
  { discriminator: "type" },
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
    sessionKey: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    channel: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: NonEmptyString,
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal("delta"),
      Type.Literal("final"),
      Type.Literal("error"),
    ]),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ProtocolSchemas: Record<string, TSchema> = {
  ConnectParams: ConnectParamsSchema,
  HelloOk: HelloOkSchema,
  RequestFrame: RequestFrameSchema,
  ResponseFrame: ResponseFrameSchema,
  EventFrame: EventFrameSchema,
  GatewayFrame: GatewayFrameSchema,
  PresenceEntry: PresenceEntrySchema,
  StateVersion: StateVersionSchema,
  Snapshot: SnapshotSchema,
  ErrorShape: ErrorShapeSchema,
  AgentEvent: AgentEventSchema,
  SendParams: SendParamsSchema,
  AgentParams: AgentParamsSchema,
  ChatHistoryParams: ChatHistoryParamsSchema,
  ChatSendParams: ChatSendParamsSchema,
  ChatEvent: ChatEventSchema,
  TickEvent: TickEventSchema,
  ShutdownEvent: ShutdownEventSchema,
};

export const PROTOCOL_VERSION = 2 as const;

export type ConnectParams = Static<typeof ConnectParamsSchema>;
export type HelloOk = Static<typeof HelloOkSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
export type GatewayFrame = Static<typeof GatewayFrameSchema>;
export type Snapshot = Static<typeof SnapshotSchema>;
export type PresenceEntry = Static<typeof PresenceEntrySchema>;
export type ErrorShape = Static<typeof ErrorShapeSchema>;
export type StateVersion = Static<typeof StateVersionSchema>;
export type AgentEvent = Static<typeof AgentEventSchema>;
export type ChatEvent = Static<typeof ChatEventSchema>;
export type TickEvent = Static<typeof TickEventSchema>;
export type ShutdownEvent = Static<typeof ShutdownEventSchema>;

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
