import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const WizardRunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
  Type.Literal("error"),
]);

export const WizardStartParamsSchema = Type.Object(
  {
    mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
    workspace: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardAnswerSchema = Type.Object(
  {
    stepId: NonEmptyString,
    value: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const WizardNextParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    answer: Type.Optional(WizardAnswerSchema),
  },
  { additionalProperties: false },
);

const WizardSessionIdParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const WizardCancelParamsSchema = WizardSessionIdParamsSchema;

export const WizardStatusParamsSchema = WizardSessionIdParamsSchema;

export const WizardStepOptionSchema = Type.Object(
  {
    value: Type.Unknown(),
    label: NonEmptyString,
    hint: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardStepSchema = Type.Object(
  {
    id: NonEmptyString,
    type: Type.Union([
      Type.Literal("note"),
      Type.Literal("select"),
      Type.Literal("text"),
      Type.Literal("confirm"),
      Type.Literal("multiselect"),
      Type.Literal("progress"),
      Type.Literal("action"),
      // New step types for onboarding wizard
      Type.Literal("welcome"),
      Type.Literal("api-key"),
      Type.Literal("workspace-path"),
      Type.Literal("gateway-config"),
      Type.Literal("channel-cards"),
      Type.Literal("agent-mode-select"),
      Type.Literal("agent-single-form"),
      Type.Literal("agent-team-count"),
      Type.Literal("agent-swarm-config"),
      Type.Literal("agent-grid"),
      Type.Literal("agent-config-advanced"),
      Type.Literal("skills-config"),
      Type.Literal("summary"),
    ]),
    title: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    options: Type.Optional(Type.Array(WizardStepOptionSchema)),
    initialValue: Type.Optional(Type.Unknown()),
    placeholder: Type.Optional(Type.String()),
    sensitive: Type.Optional(Type.Boolean()),
    executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")])),
    // Additional fields for new step types
    icon: Type.Optional(Type.String()),
    logo: Type.Optional(Type.String()),
    validation: Type.Optional(
      Type.Object({
        pattern: Type.Optional(Type.String()),
        min: Type.Optional(Type.Number()),
        max: Type.Optional(Type.Number()),
        required: Type.Optional(Type.Boolean()),
      }),
    ),
    items: Type.Optional(Type.Array(Type.Object({ id: Type.String(), label: Type.String(), icon: Type.Optional(Type.String()) }))),
    summary: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.String() }))),
  },
  { additionalProperties: false },
);

const WizardResultFields = {
  done: Type.Boolean(),
  step: Type.Optional(WizardStepSchema),
  status: Type.Optional(WizardRunStatusSchema),
  error: Type.Optional(Type.String()),
};

export const WizardNextResultSchema = Type.Object(WizardResultFields, {
  additionalProperties: false,
});

export const WizardStartResultSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    ...WizardResultFields,
  },
  { additionalProperties: false },
);

export const WizardStatusResultSchema = Type.Object(
  {
    status: WizardRunStatusSchema,
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
