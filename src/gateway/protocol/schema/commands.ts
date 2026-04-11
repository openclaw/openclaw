import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const CommandSourceSchema = Type.Union([
  Type.Literal("native"),
  Type.Literal("skill"),
  Type.Literal("plugin"),
]);

export const CommandScopeSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("native"),
  Type.Literal("both"),
]);

export const CommandCategorySchema = Type.Union([
  Type.Literal("session"),
  Type.Literal("options"),
  Type.Literal("status"),
  Type.Literal("management"),
  Type.Literal("media"),
  Type.Literal("tools"),
  Type.Literal("docks"),
]);

export const CommandArgChoiceSchema = Type.Object(
  {
    value: Type.String(),
    label: Type.String(),
  },
  { additionalProperties: false },
);

export const CommandArgSchema = Type.Object(
  {
    name: NonEmptyString,
    description: Type.String(),
    type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]),
    required: Type.Optional(Type.Boolean()),
    choices: Type.Optional(Type.Array(CommandArgChoiceSchema)),
    dynamic: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const CommandEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    nativeName: Type.Optional(NonEmptyString),
    textAliases: Type.Optional(Type.Array(NonEmptyString)),
    description: Type.String(),
    category: Type.Optional(CommandCategorySchema),
    source: CommandSourceSchema,
    scope: CommandScopeSchema,
    acceptsArgs: Type.Boolean(),
    args: Type.Optional(Type.Array(CommandArgSchema)),
  },
  { additionalProperties: false },
);

export const CommandsListParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    provider: Type.Optional(NonEmptyString),
    scope: Type.Optional(CommandScopeSchema),
    includeArgs: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const CommandsListResultSchema = Type.Object(
  {
    commands: Type.Array(CommandEntrySchema),
  },
  { additionalProperties: false },
);
