/** Origin class for plugin discovery and runtime trust decisions. */
export type PluginOrigin = "bundled" | "global" | "workspace" | "config";

// Explicit selection favors nearby operator sources; provider setup favors
// bundled metadata over workspace packages. These are intentionally different.
export const PLUGIN_ORIGIN_PRIORITIES: Readonly<
  Record<PluginOrigin, { explicit: number; provider: number }>
> = {
  config: { explicit: 0, provider: 0 },
  workspace: { explicit: 1, provider: 3 },
  global: { explicit: 2, provider: 2 },
  bundled: { explicit: 3, provider: 1 },
};
