import { Type } from "typebox";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { requesterProfileSchema } from "../schema/typebox.js";

export const SessionsSendToolSchema = Type.Object({
  user: requesterProfileSchema({ defaultToTurnOwner: true }),
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
  },
  { additionalProperties: false },
);

export const SessionsSendOutputSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("started"),
      async: Type.Literal(true),
      runId: Type.String(),
      sessionKey: Type.String(),
      mode: Type.Union([Type.Literal("resume"), Type.Literal("followup")]),
      retained: Type.Object(
        {
          acceptance: Type.Literal("not_accepted"),
          reason: Type.Literal("plugin_reload_self_hold"),
          plugins: Type.Array(Type.String()),
          durability: Type.Literal("process"),
          continuation: Type.Literal("after_turn"),
        },
        { additionalProperties: false },
      ),
      message: Type.String(),
    },
    { additionalProperties: false },
  ),
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
      selfHold: Type.Optional(
        Type.Object(
          {
            retained: Type.Literal(false),
            acceptance: Type.Union([Type.Literal("not_accepted"), Type.Literal("uncertain")]),
            plugins: Type.Array(Type.String()),
            why: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
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
      replyTruncated: Type.Optional(Type.Literal(true)),
      note: Type.Optional(Type.String()),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);
