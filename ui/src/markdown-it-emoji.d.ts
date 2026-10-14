declare module "markdown-it-emoji" {
  import type { PluginWithOptions } from "markdown-it";

  export const full: PluginWithOptions<{ shortcuts?: Record<string, string | string[]> }>;
}

declare module "markdown-it-emoji/lib/data/full.mjs" {
  const definitions: Readonly<Record<string, string>>;
  export default definitions;
}
