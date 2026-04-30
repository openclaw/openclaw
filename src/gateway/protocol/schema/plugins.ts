import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const PluginJsonValueSchema = Type.Unknown();

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

export const PluginsListParamsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    diagnostics: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PluginsInspectParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PluginsDoctorParamsSchema = Type.Object({}, { additionalProperties: false });

export const PluginsRegistryStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const PluginsRegistryRefreshParamsSchema = Type.Object({}, { additionalProperties: false });

export const PluginsInstallParamsSchema = Type.Object(
  {
    source: Type.String({ enum: ["path", "npm", "clawhub"] }),
    path: Type.Optional(NonEmptyString),
    spec: Type.Optional(NonEmptyString),
    force: Type.Optional(Type.Boolean()),
    link: Type.Optional(Type.Boolean()),
    pin: Type.Optional(Type.Boolean()),
    dangerouslyForceUnsafeInstall: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const PluginsUpdateParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    all: Type.Optional(Type.Boolean()),
    dryRun: Type.Optional(Type.Boolean()),
    dangerouslyForceUnsafeInstall: Type.Optional(Type.Boolean()),
    allowIntegrityDrift: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const PluginsUninstallParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    force: Type.Optional(Type.Boolean()),
    keepFiles: Type.Optional(Type.Boolean()),
    dryRun: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PluginsEnableParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PluginsDisableParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);
