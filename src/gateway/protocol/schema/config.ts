import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * ConfigGetParams supports filtering to reduce response size.
 *
 * For MCP/agent callers:
 * - Use `path` for dot-notation access (e.g., "agents.defaults.model")
 * - Use `section` for top-level sections (e.g., "channels", "agents")
 * - Use `full: true` explicitly when you need the entire config
 * - Calls without any filter will return the full config (backwards compatible)
 *   but agents SHOULD specify what they need to reduce token usage.
 */
export const ConfigGetParamsSchema = Type.Object(
  {
    // Dot-notation path to extract (e.g., "agents.defaults.model")
    path: Type.Optional(Type.String()),
    // Top-level section to return (e.g., "channels", "agents", "plugins")
    section: Type.Optional(Type.String()),
    // Explicit flag to request full config (for intentionality)
    full: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ConfigSetParamsSchema = Type.Object(
  {
    raw: NonEmptyString,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ConfigApplyParamsSchema = Type.Object(
  {
    raw: NonEmptyString,
    baseHash: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ConfigPatchParamsSchema = Type.Object(
  {
    raw: NonEmptyString,
    baseHash: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const GatewayStartupCommandLogSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("inherit"), Type.Literal("file"), Type.Literal("discard")]),
    ),
    stdoutPath: Type.Optional(Type.String()),
    stderrPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const GatewayStartupCommandSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    command: NonEmptyString,
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    enabled: Type.Optional(Type.Boolean()),
    startPolicy: Type.Optional(
      Type.Union([Type.Literal("always"), Type.Literal("reuse"), Type.Literal("never")]),
    ),
    stopSignal: Type.Optional(Type.String()),
    stopTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    restart: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("on-failure")])),
    log: Type.Optional(GatewayStartupCommandLogSchema),
  },
  { additionalProperties: false },
);

export const StartupCommandsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const StartupCommandsAppendParamsSchema = Type.Object(
  {
    startupCommand: GatewayStartupCommandSchema,
    baseHash: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const StartupCommandsRemoveParamsSchema = Type.Object(
  {
    startupCommandId: NonEmptyString,
    baseHash: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/**
 * ConfigSchemaParams supports filtering to reduce response size.
 *
 * For MCP/agent callers:
 * - Use `section` to get schema for a specific top-level section (e.g., "agents", "channels")
 * - Use `path` for schema at a specific dot-notation path
 * - Use `full: true` explicitly when you need the entire schema
 * - Calls without any filter will return the full schema (backwards compatible)
 *   but agents SHOULD specify what they need - the full schema is ~955KB!
 *
 * IMPORTANT: The schema rarely changes (only when plugins/channels are added).
 * Consider caching the schema client-side and using the `version` field to invalidate.
 */
export const ConfigSchemaParamsSchema = Type.Object(
  {
    // Top-level section to return schema for (e.g., "agents", "channels", "plugins")
    section: Type.Optional(Type.String()),
    // Dot-notation path to return schema for
    path: Type.Optional(Type.String()),
    // Explicit flag to request full schema (for intentionality)
    full: Type.Optional(Type.Boolean()),
    // Client's cached schema version - if matches current, returns 304-style "not modified"
    ifNoneMatch: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const UpdateRunParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const ConfigUiHintSchema = Type.Object(
  {
    label: Type.Optional(Type.String()),
    help: Type.Optional(Type.String()),
    group: Type.Optional(Type.String()),
    order: Type.Optional(Type.Integer()),
    advanced: Type.Optional(Type.Boolean()),
    sensitive: Type.Optional(Type.Boolean()),
    placeholder: Type.Optional(Type.String()),
    itemTemplate: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ConfigSchemaResponseSchema = Type.Object(
  {
    schema: Type.Unknown(),
    uiHints: Type.Record(Type.String(), ConfigUiHintSchema),
    version: NonEmptyString,
    generatedAt: NonEmptyString,
  },
  { additionalProperties: false },
);
