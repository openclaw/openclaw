import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import type { GatewayConfig } from "../config/types.gateway.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { readEffectiveMemoryLimit } from "./host-memory.js";

const LEAN_PROFILE_MEMORY_THRESHOLD_BYTES = 8 * 1024 ** 3;

export type ResourceProfile = "standard" | "lean";

export type GatewayResourceProfile = {
  configured: "auto" | "standard" | "lean";
  profile: ResourceProfile;
  reason: "explicit" | "memory" | "capacity";
  memoryLimitBytes: number;
  memoryLimitSource: "cgroup-v2" | "host";
  cpus: number;
};

type StartupResourceProfile = {
  active: boolean;
  current?: Readonly<GatewayResourceProfile>;
};

const owner = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayResourceProfile"),
  (): {
    current?: Readonly<GatewayResourceProfile>;
    startup: AsyncLocalStorage<StartupResourceProfile>;
    listeners: Set<(profile: ResourceProfile) => void>;
  } => ({ listeners: new Set(), startup: new AsyncLocalStorage() }),
  (state) => {
    state.current = undefined;
    state.listeners.clear();
  },
);

/** Keep unresolved/failed starts from borrowing or replacing another generation's policy. */
export async function withGatewayStartupResourceProfile<T>(
  run: () => Promise<T>,
  reuse = false,
): Promise<T> {
  if (reuse && owner.startup.getStore()?.active) {
    return await run();
  }
  const state: StartupResourceProfile = { active: true };
  return await owner.startup.run(state, async () => {
    try {
      return await run();
    } finally {
      // Descendant timers must use the published policy after startup has settled.
      state.active = false;
    }
  });
}

/** Called only with a Gateway startup source that passed core validation. */
export function prepareGatewayResourceProfile(resources: GatewayConfig["resources"]) {
  const state = owner.startup.getStore();
  if (state?.active && state.current?.configured !== (resources?.profile ?? "auto")) {
    state.current = resolveGatewayResourceProfile(resources);
  }
}

/** Detached physical owners carry only placement, never the opening caller's async context. */
export function captureGatewayStartupWorkerPlacement(): { profile?: ResourceProfile } | undefined {
  const state = owner.startup.getStore();
  return state?.active ? { profile: state.current?.profile } : undefined;
}

function resolveProfile(
  configured: GatewayResourceProfile["configured"],
  memoryLimitBytes: number,
): Pick<GatewayResourceProfile, "profile" | "reason"> {
  if (configured !== "auto") {
    return { profile: configured, reason: "explicit" };
  }
  return memoryLimitBytes < LEAN_PROFILE_MEMORY_THRESHOLD_BYTES
    ? { profile: "lean", reason: "memory" }
    : { profile: "standard", reason: "capacity" };
}

/**
 * The profile startup will resolve for this configured value, for work that must start
 * before bootstrap publishes it. Reads host memory; publishes nothing.
 */
export function predictGatewayResourceProfile(
  configured: GatewayResourceProfile["configured"] | undefined,
): ResourceProfile {
  return resolveProfile(configured ?? "auto", readEffectiveMemoryLimit().memoryLimitBytes).profile;
}

function resolveGatewayResourceProfile(resources: GatewayConfig["resources"]) {
  const configured = resources?.profile ?? "auto";
  const memory = readEffectiveMemoryLimit();
  const cpus = os.availableParallelism();
  return Object.freeze({
    configured,
    ...resolveProfile(configured, memory.memoryLimitBytes),
    ...memory,
    cpus,
  });
}

/** Resolve once at Gateway startup; readers never inspect config or host files. */
export function initializeGatewayResourceProfile(resources: GatewayConfig["resources"]) {
  const previous = owner.current?.profile ?? "standard";
  owner.current = resolveGatewayResourceProfile(resources);
  const state = owner.startup.getStore();
  if (state?.active) {
    state.current = owner.current;
  }
  if (owner.current.profile !== previous) {
    notifyListeners(owner.listeners, owner.current.profile);
  }
  return owner.current;
}

/** Resolved host policy; standalone callers retain standard behavior. No host I/O. */
export function getResourceProfile(): ResourceProfile {
  return getGatewayResourceProfile()?.profile ?? "standard";
}

/** Observe future changes, not an initial snapshot. Unsubscribe when the plugin disposes. */
export function onResourceProfileChange(listener: (profile: ResourceProfile) => void): () => void {
  return registerListener(owner.listeners, listener);
}

/** Undefined outside a running Gateway; do not substitute a CLI process's host facts. */
export function getGatewayResourceProfile(): Readonly<GatewayResourceProfile> | undefined {
  const state = owner.startup.getStore();
  return state?.active ? state.current : owner.current;
}
