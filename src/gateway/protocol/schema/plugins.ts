import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const PluginJsonValueSchema = Type.Cyclic(
  {
    PluginJsonValue: Type.Union([
      Type.Null(),
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Array(Type.Ref("PluginJsonValue")),
      Type.Record(Type.String(), Type.Ref("PluginJsonValue")),
    ]),
  },
  "PluginJsonValue",
);

export const PluginControlUiDescriptorSchema = Type.Object(
  {
    id: NonEmptyString,
    pluginId: NonEmptyString,
    pluginName: Type.Optional(NonEmptyString),
    surface: Type.Union([
      Type.Literal("session"),
      Type.Literal("tool"),
      Type.Literal("run"),
      Type.Literal("settings"),
    ]),
    label: NonEmptyString,
    description: Type.Optional(Type.String()),
    placement: Type.Optional(Type.String()),
    renderer: Type.Optional(Type.String()),
    stateNamespace: Type.Optional(Type.String()),
    actionIds: Type.Optional(Type.Array(NonEmptyString)),
    schema: Type.Optional(PluginJsonValueSchema),
    requiredScopes: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

export const PluginsUiDescriptorsParamsSchema = Type.Object({}, { additionalProperties: false });

export const PluginsUiDescriptorsResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    descriptors: Type.Array(PluginControlUiDescriptorSchema),
  },
  { additionalProperties: false },
);

export const PluginsSessionActionParamsSchema = Type.Object(
  {
    pluginId: NonEmptyString,
    actionId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    payload: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

// Plugin-declared action failures are returned as a successful RPC
// (transport-level `ok: true`) with the plugin payload's `ok: false` plus
// typed `error` / optional `code` / optional `details` fields. Transport
// errors (validation, schema mismatch, dispatch error) still go through
// errorShape. Per copilot review on plugins.ts:69 — declare both the
// success and failure shapes so generated clients (e.g. Swift) decode the
// failure path correctly instead of dropping fields under
// `additionalProperties: false`.
export const PluginsSessionActionResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    result: Type.Optional(PluginJsonValueSchema),
    continueAgent: Type.Optional(Type.Boolean()),
    reply: Type.Optional(PluginJsonValueSchema),
    error: Type.Optional(Type.String()),
    code: Type.Optional(Type.String()),
    details: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);
