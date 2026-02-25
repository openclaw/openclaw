import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// Builder API Schemas für programmatisches Agent-Management

export const BuilderSetApiKeyParamsSchema = Type.Object(
  {
    provider: NonEmptyString, // "anthropic", "openai", "openrouter", etc.
    apiKey: NonEmptyString,
    profileId: Type.Optional(NonEmptyString), // Optional, defaults to "provider:default"
    agentId: Type.Optional(NonEmptyString), // Optional, für agent-spezifische Keys
  },
  { additionalProperties: false },
);

export const BuilderSetApiKeyResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    provider: NonEmptyString,
    profileId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const BuilderCreateAgentParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    workspace: Type.Optional(NonEmptyString), // Optional, defaults to ~/.activi/workspace/{agentId}
    model: Type.Optional(NonEmptyString), // Optional model ID
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
    identity: Type.Optional(
      Type.Object({
        name: Type.Optional(NonEmptyString),
        emoji: Type.Optional(Type.String()),
        avatar: Type.Optional(Type.String()),
      }),
    ),
  },
  { additionalProperties: false },
);

export const BuilderCreateAgentResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    name: NonEmptyString,
    workspace: NonEmptyString,
  },
  { additionalProperties: false },
);

export const BuilderDeployAgentParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    config: Type.Optional(
      Type.Object({
        model: Type.Optional(NonEmptyString),
        tools: Type.Optional(Type.Array(NonEmptyString)),
        skills: Type.Optional(Type.Array(NonEmptyString)),
      }),
    ),
  },
  { additionalProperties: false },
);

export const BuilderDeployAgentResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    deployed: Type.Boolean(),
  },
  { additionalProperties: false },
);

// Type exports
export type BuilderSetApiKeyParams = Static<typeof BuilderSetApiKeyParamsSchema>;
export type BuilderSetApiKeyResult = Static<typeof BuilderSetApiKeyResultSchema>;
export type BuilderCreateAgentParams = Static<typeof BuilderCreateAgentParamsSchema>;
export type BuilderCreateAgentResult = Static<typeof BuilderCreateAgentResultSchema>;
export type BuilderDeployAgentParams = Static<typeof BuilderDeployAgentParamsSchema>;
export type BuilderDeployAgentResult = Static<typeof BuilderDeployAgentResultSchema>;
