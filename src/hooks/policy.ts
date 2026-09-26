import type { HookConfig } from "../config/types.hooks.js";
// Hook policy helpers decide when hooks may run for a configured event.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHookKey } from "./frontmatter.js";
import type { HookPolicyEntry, HookSource } from "./types.js";

/** Human-readable reason for disabling a hook at policy resolution time. */
export type HookEnableStateReason = "disabled in config" | "workspace hook (disabled by default)";

type HookEnableState = {
  enabled: boolean;
  reason?: HookEnableStateReason;
};

type HookResolutionCollision<T> = {
  name: string;
  kept: T;
  ignored: T;
};

const HOOK_SOURCE_PRECEDENCE: Record<HookSource, number> = {
  "openclaw-bundled": 10,
  "openclaw-plugin": 20,
  "openclaw-managed": 30,
  "openclaw-workspace": 40,
};

/** Resolve explicit per-hook config by hook key. */
export function resolveHookConfig(
  config: OpenClawConfig | undefined,
  hookKey: string,
): HookConfig | undefined {
  const hooks = config?.hooks?.internal?.entries;
  if (!hooks || typeof hooks !== "object") {
    return undefined;
  }
  const entry = (hooks as Record<string, HookConfig | undefined>)[hookKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry;
}

/** Resolve whether a hook is enabled before runtime requirement checks. */
export function resolveHookEnableState(params: {
  entry: HookPolicyEntry;
  config?: OpenClawConfig;
  hookConfig?: HookConfig;
}): HookEnableState {
  const { entry, config } = params;
  const hookKey = resolveHookKey(entry.hook.name, entry);
  const hookConfig = params.hookConfig ?? resolveHookConfig(config, hookKey);

  if (entry.hook.source === "openclaw-plugin") {
    return { enabled: true };
  }
  if (hookConfig?.enabled === false) {
    return { enabled: false, reason: "disabled in config" };
  }

  if (entry.hook.source === "openclaw-workspace" && hookConfig?.enabled !== true) {
    return { enabled: false, reason: "workspace hook (disabled by default)" };
  }

  return { enabled: true };
}

/** Merge hook entries by name using source precedence and override policy. */
export function resolveHookEntries<T extends HookPolicyEntry>(
  entries: T[],
  opts?: {
    onCollisionIgnored?: (collision: HookResolutionCollision<T>) => void;
  },
): T[] {
  const ordered = entries.toSorted(
    (a, b) => HOOK_SOURCE_PRECEDENCE[a.hook.source] - HOOK_SOURCE_PRECEDENCE[b.hook.source],
  );

  const merged = new Map<string, T>();
  for (const entry of ordered) {
    const existing = merged.get(entry.hook.name);
    if (!existing) {
      merged.set(entry.hook.name, entry);
      continue;
    }
    // Precedence orders sources, but workspace code is isolated and bundled/plugin ties keep the first entry.
    const sameSource = entry.hook.source === existing.hook.source;
    if (
      entry.hook.source === "openclaw-workspace"
        ? sameSource
        : !sameSource || entry.hook.source === "openclaw-managed"
    ) {
      merged.set(entry.hook.name, entry);
      continue;
    }
    opts?.onCollisionIgnored?.({
      name: entry.hook.name,
      kept: existing,
      ignored: entry,
    });
  }

  return Array.from(merged.values());
}
