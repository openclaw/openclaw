import { Type } from "typebox";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";

export const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  watch: Type.Optional(Type.Boolean()),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("notify"),
      Type.Literal("steer"),
      Type.Literal("followup"),
      Type.Literal("resume"),
    ]),
  ),
});

const SessionsSendDeliverySchema = Type.Object(
  {
    status: Type.Union([Type.Literal("pending"), Type.Literal("skipped")]),
    mode: Type.Literal("announce"),
  },
  { additionalProperties: false },
);

export const SessionsSendOutputSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("accepted"),
      mode: Type.Literal("resume"),
      runId: Type.String(),
      taskRunId: Type.String(),
      sessionKey: Type.String(),
      completion: Type.Literal("task"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("queued"),
      sessionKey: Type.String(),
      notificationId: Type.String(),
      durability: Type.Literal("process"),
      runStarted: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Union([Type.Literal("error"), Type.Literal("forbidden")]),
      error: Type.String(),
      sessionKey: Type.Optional(Type.String()),
      sentBeforeError: Type.Optional(Type.Literal(true)),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("accepted"),
      sessionKey: Type.String(),
      targetDisposition: Type.Union([Type.Literal("queued"), Type.Literal("steered")]),
      delivery: SessionsSendDeliverySchema,
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("timeout"),
      error: Type.String(),
      sentBeforeError: Type.Literal(true),
      sessionKey: Type.String(),
      delivery: Type.Optional(SessionsSendDeliverySchema),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("no_reply"),
      sessionKey: Type.String(),
      message: Type.String(),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("ok"),
      sessionKey: Type.String(),
      delivery: SessionsSendDeliverySchema,
      reply: Type.String(),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);
