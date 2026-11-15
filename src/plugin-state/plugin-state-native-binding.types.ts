import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { PluginStateOverflowPolicy } from "./plugin-state-store.types.js";

export type PluginStateNativeBindingCodec = "codex" | "agentsapi";

export type PluginStateNativeBindingPlan = {
  codec: PluginStateNativeBindingCodec;
  codecSource?: { rootDir: string; source: string; origin: PluginOrigin };
  predicate: { kind: "absent" } | { kind: "leased"; token: string; value: unknown };
  pluginId: string;
  namespace: string;
  key: string;
  maxEntries: number | undefined;
  overflowPolicy: PluginStateOverflowPolicy;
  ttlMs?: number;
  staleMs: number;
  deletionChanged: string;
  rollbackChanged: string;
};

export type PluginStateNativeBindingDeletion =
  | { status: "absent" }
  | { status: "deleted"; value: Record<string, unknown> }
  | { status: "conflict" };

export type PluginStateNativeBindingRecord = {
  lease?: { token: string; expiresAt: number };
  [key: string]: unknown;
};
