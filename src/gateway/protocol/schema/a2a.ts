import { Static, Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// ── a2a.task.request ──────────────────────────────────────────
export const A2ATaskRequestParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    request: Type.Object(
      {
        method: Type.Literal("a2a.task.request"),
        taskId: Type.Optional(NonEmptyString),
        correlationId: Type.Optional(NonEmptyString),
        parentRunId: Type.Optional(NonEmptyString),
        requester: Type.Optional(
          Type.Object(
            {
              sessionKey: NonEmptyString,
              displayKey: NonEmptyString,
              channel: Type.Optional(NonEmptyString),
            },
            { additionalProperties: false },
          ),
        ),
        target: Type.Object(
          {
            sessionKey: NonEmptyString,
            displayKey: NonEmptyString,
            channel: Type.Optional(NonEmptyString),
          },
          { additionalProperties: false },
        ),
        task: Type.Object(
          {
            intent: Type.Union([
              Type.Literal("delegate"),
              Type.Literal("ask"),
              Type.Literal("handoff"),
              Type.Literal("notify"),
            ]),
            summary: Type.Optional(NonEmptyString),
            instructions: NonEmptyString,
            input: Type.Optional(Type.Record(NonEmptyString, Type.Unknown())),
            expectedOutput: Type.Optional(
              Type.Object(
                {
                  format: Type.Union([Type.Literal("text"), Type.Literal("json")]),
                  schemaName: Type.Optional(NonEmptyString),
                },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        constraints: Type.Optional(
          Type.Object(
            {
              timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
              maxPingPongTurns: Type.Optional(Type.Integer({ minimum: 0 })),
              requireFinal: Type.Optional(Type.Boolean()),
              allowAnnounce: Type.Optional(Type.Boolean()),
              priority: Type.Optional(
                Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]),
              ),
            },
            { additionalProperties: false },
          ),
        ),
        runtime: Type.Optional(
          Type.Object(
            {
              announceTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
              maxPingPongTurns: Type.Optional(Type.Integer({ minimum: 0 })),
              roundOneReply: Type.Optional(Type.String()),
              waitRunId: Type.Optional(NonEmptyString),
              cancelTarget: Type.Optional(
                Type.Object(
                  {
                    kind: Type.Literal("session_run"),
                    sessionKey: NonEmptyString,
                    runId: Type.Optional(NonEmptyString),
                  },
                  { additionalProperties: false },
                ),
              ),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type A2ATaskRequestParams = Static<typeof A2ATaskRequestParamsSchema>;

// ── a2a.task.update ──────────────────────────────────────────
export const A2ATaskUpdateParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    update: Type.Object(
      {
        method: Type.Literal("a2a.task.update"),
        taskId: NonEmptyString,
        correlationId: Type.Optional(NonEmptyString),
        parentRunId: Type.Optional(NonEmptyString),
        executionStatus: Type.Optional(
          Type.Union([
            Type.Literal("accepted"),
            Type.Literal("running"),
            Type.Literal("waiting_reply"),
            Type.Literal("waiting_external"),
            Type.Literal("completed"),
            Type.Literal("failed"),
            Type.Literal("timed_out"),
          ]),
        ),
        summary: Type.Optional(Type.String()),
        output: Type.Optional(Type.Unknown()),
        heartbeat: Type.Optional(Type.Boolean()),
        at: Type.Optional(Type.Number()),
        error: Type.Optional(
          Type.Object(
            {
              code: NonEmptyString,
              message: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        deliveryStatus: Type.Optional(
          Type.Union([Type.Literal("sent"), Type.Literal("skipped"), Type.Literal("failed")]),
        ),
        deliveryErrorMessage: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type A2ATaskUpdateParams = Static<typeof A2ATaskUpdateParamsSchema>;

// ── a2a.task.cancel ──────────────────────────────────────────
export const A2ATaskCancelParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    cancel: Type.Object(
      {
        method: Type.Literal("a2a.task.cancel"),
        taskId: NonEmptyString,
        correlationId: Type.Optional(NonEmptyString),
        parentRunId: Type.Optional(NonEmptyString),
        at: Type.Optional(Type.Number()),
        reason: Type.Optional(Type.String()),
        runId: Type.Optional(NonEmptyString),
        targetSessionKey: Type.Optional(NonEmptyString),
        cancelTarget: Type.Optional(
          Type.Object(
            {
              kind: Type.Literal("session_run"),
              sessionKey: NonEmptyString,
              runId: Type.Optional(NonEmptyString),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type A2ATaskCancelParams = Static<typeof A2ATaskCancelParamsSchema>;

// ── a2a.task.status ──────────────────────────────────────────
export const A2ATaskStatusParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    taskId: NonEmptyString,
  },
  { additionalProperties: false },
);

export type A2ATaskStatusParams = Static<typeof A2ATaskStatusParamsSchema>;
