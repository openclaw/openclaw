// Leaf contract for memory plugin role identifiers shared by config, SDK, hooks, and runtime surfaces.
export const MEMORY_PLUGIN_ROLES = [
  "recall",
  "compaction",
  "capture",
  "dreaming",
  "userModel",
] as const;

export type MemoryPluginRole = (typeof MEMORY_PLUGIN_ROLES)[number];
