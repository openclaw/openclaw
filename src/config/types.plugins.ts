// Defines plugin entry and install configuration types.

import type { z } from "zod";
import type { PluginAcceptedDeclaredSurface, PluginInstallRecord } from "./zod-schema.installs.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";
export type { PluginAcceptedDeclaredSurface, PluginInstallRecord };

type PluginsSchemaInput = NonNullable<z.input<typeof OpenClawSchemaShape.plugins>>;

export type PluginEntryConfig = NonNullable<PluginsSchemaInput["entries"]>[string];

export type PluginSlotsConfig = NonNullable<PluginsSchemaInput["slots"]>;

export type PluginsLoadConfig = NonNullable<PluginsSchemaInput["load"]>;

export type PluginsConfig = PluginsSchemaInput & {
  /**
   * Internal transient carrier for plugin install records during command flows.
   * This is intentionally omitted from the config schema and must not be
   * persisted to openclaw.json.
   */
  installs?: Record<string, PluginInstallRecord>;
};
