import { loadGeneratedBundledPluginEntries } from "../generated/bundled-plugin-entries.generated.js";
import type { OpenClawPluginDefinition } from "./types.js";

type BundledRegistrablePlugin = OpenClawPluginDefinition & {
  id: string;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
};

export const BUNDLED_PLUGIN_ENTRIES =
  (await loadGeneratedBundledPluginEntries()) as unknown as readonly BundledRegistrablePlugin[];
