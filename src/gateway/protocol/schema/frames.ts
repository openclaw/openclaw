import { Type } from "@sinclair/typebox";
import { GatewayClientIdSchema, GatewayClientModeSchema, NonEmptyString } from "./primitives.js";
import { SnapshotSchema, StateVersionSchema } from "./snapshot.js";

const FRAME_TEXT_MAX = 256;
const FRAME_ID_MAX = 128;
const CONNECT_TEXT_MAX = 256;
const CONNECT_PATH_ENV_MAX = 8_192;
const CONNECT_SECRET_MAX = 8_192;
const CONNECT_SIGNATURE_MAX = 16_384;
const CONNECT_LIST_MAX = 256;
const CONNECT_PERMISSION_MAX = 256;

const FrameString = Type.String({ minLength: 1, maxLength: FRAME_TEXT_MAX });
const FrameIdString = Type.String({ minLength: 1, maxLength: FRAME_ID_MAX });
const ConnectString = Type.String({ minLength: 1, maxLength: CONNECT_TEXT_MAX });
const ConnectSecretString = Type.String({ minLength: 1, maxLength: CONNECT_SECRET_MAX });

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
        id: GatewayClientIdSchema,
        displayName: Type.Optional(ConnectString),
        version: ConnectString,
        platform: ConnectString,
        deviceFamily: Type.Optional(ConnectString),
        modelIdentifier: Type.Optional(ConnectString),
        mode: GatewayClientModeSchema,
        instanceId: Type.Optional(ConnectString),
      },
      { additionalProperties: false },
    ),
    caps: Type.Optional(Type.Array(ConnectString, { default: [], maxItems: CONNECT_LIST_MAX })),
    commands: Type.Optional(Type.Array(ConnectString, { maxItems: CONNECT_LIST_MAX })),
    permissions: Type.Optional(
      Type.Record(ConnectString, Type.Boolean(), { maxProperties: CONNECT_PERMISSION_MAX }),
    ),
    pathEnv: Type.Optional(Type.String({ maxLength: CONNECT_PATH_ENV_MAX })),
    role: Type.Optional(ConnectString),
    scopes: Type.Optional(Type.Array(ConnectString, { maxItems: CONNECT_LIST_MAX })),
    device: Type.Optional(
      Type.Object(
        {
          id: ConnectString,
          publicKey: ConnectSecretString,
          signature: Type.String({ minLength: 1, maxLength: CONNECT_SIGNATURE_MAX }),
          signedAt: Type.Integer({ minimum: 0 }),
          nonce: ConnectSecretString,
        },
        { additionalProperties: false },
      ),
    ),
    auth: Type.Optional(
      Type.Object(
        {
          token: Type.Optional(Type.String({ maxLength: CONNECT_SECRET_MAX })),
          password: Type.Optional(Type.String({ maxLength: CONNECT_SECRET_MAX })),
        },
        { additionalProperties: false },
      ),
    ),
    locale: Type.Optional(Type.String({ maxLength: CONNECT_TEXT_MAX })),
    userAgent: Type.Optional(Type.String({ maxLength: CONNECT_PATH_ENV_MAX })),
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
    canvasHostUrl: Type.Optional(NonEmptyString),
    auth: Type.Optional(
      Type.Object(
        {
          deviceToken: NonEmptyString,
          role: NonEmptyString,
          scopes: Type.Array(NonEmptyString),
          issuedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
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
    id: FrameIdString,
    method: FrameString,
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
