import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const GeneratingMetadataSchema = Type.Object(
  {
    thinkingLevel: Type.Optional(Type.String()),
    reasoningLevel: Type.String(),
    source: Type.Union([
      Type.Literal("inline-directive"),
      Type.Literal("session-directive"),
      Type.Literal("auto-meta"),
      Type.Literal("auto-fallback"),
      Type.Literal("default"),
    ]),
    autoReasoningEnabled: Type.Boolean(),
    availableThinkingLevels: Type.Array(Type.String()),
    selector: Type.Optional(
      Type.Object({
        used: Type.Boolean(),
        provider: Type.String(),
        model: Type.String(),
        timedOut: Type.Optional(Type.Boolean()),
        fallbackUsed: Type.Optional(Type.Boolean()),
      }),
    ),
    routingPass: Type.Optional(
      Type.Object({
        pass: Type.Union([Type.Literal(1), Type.Literal(2)]),
        tag: Type.Optional(Type.Literal("expensive")),
        pass1TokenUsage: Type.Optional(
          Type.Object({
            input: Type.Optional(Type.Number()),
            output: Type.Optional(Type.Number()),
            estimated: Type.Optional(Type.Boolean()),
          }),
        ),
        pass2TokenUsage: Type.Optional(
          Type.Object({
            input: Type.Optional(Type.Number()),
            output: Type.Optional(Type.Number()),
          }),
        ),
      }),
    ),
  },
  { additionalProperties: false },
);

export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

export const LogsTailResultSchema = Type.Object(
  {
    file: NonEmptyString,
    cursor: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 0 }),
    lines: Type.Array(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    reset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatAbortParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    runId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChatInjectParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: NonEmptyString,
    label: Type.Optional(Type.String({ maxLength: 100 })),
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
      Type.Literal("aborted"),
      Type.Literal("error"),
    ]),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
    /** Optional generating metadata (thinking/reasoning levels, model selector). */
    generating: Type.Optional(GeneratingMetadataSchema),
  },
  { additionalProperties: false },
);
