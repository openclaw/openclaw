import { Type } from "typebox";
import {
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
} from "../../../infra/plugin-approvals.js";
import { NonEmptyString } from "./primitives.js";

const PluginApprovalDecisionSchema = Type.String({
  enum: ["allow-once", "allow-always", "deny"],
});

export const PluginApprovalRequestParamsSchema = Type.Object(
  {
    actions: Type.Optional(
      Type.Array(
        Type.Object(
          {
            kind: Type.String({ enum: ["decision", "command"] }),
            label: NonEmptyString,
            style: Type.String({ enum: ["primary", "success", "danger"] }),
            decision: Type.Optional(NonEmptyString),
            commandTemplate: NonEmptyString,
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 4 },
      ),
    ),
    allowedDecisions: Type.Optional(
      Type.Array(PluginApprovalDecisionSchema, { minItems: 1, maxItems: 3 }),
    ),
    pluginId: Type.Optional(NonEmptyString),
    title: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_TITLE_MAX_LENGTH }),
    description: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH }),
    severity: Type.Optional(Type.String({ enum: ["info", "warning", "critical"] })),
    toolName: Type.Optional(Type.String()),
    toolCallId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    turnSourceChannel: Type.Optional(Type.String()),
    turnSourceTo: Type.Optional(Type.String()),
    turnSourceAccountId: Type.Optional(Type.String()),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PLUGIN_APPROVAL_TIMEOUT_MS })),
    keepPendingWithoutRoute: Type.Optional(Type.Boolean()),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PluginApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PluginApprovalResolveVerifiedParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
    pluginId: NonEmptyString,
  },
  { additionalProperties: false },
);
