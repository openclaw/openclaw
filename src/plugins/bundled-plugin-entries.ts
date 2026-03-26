import { GENERATED_BUNDLED_PLUGIN_ENTRIES } from "../generated/bundled-plugin-entries.generated.js";
import type { OpenClawPluginDefinition } from "./types.js";

type BundledRegistrablePlugin = OpenClawPluginDefinition & {
  id: string;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
};

export const BUNDLED_PLUGIN_ENTRIES =
  GENERATED_BUNDLED_PLUGIN_ENTRIES as unknown as readonly BundledRegistrablePlugin[];
