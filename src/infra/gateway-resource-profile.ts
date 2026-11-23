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

const owner = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayResourceProfile"),
  (): {
    current?: Readonly<GatewayResourceProfile>;
    listeners: Set<(profile: ResourceProfile) => void>;
  } => ({ listeners: new Set() }),
  (state) => {
    state.current = undefined;
    state.listeners.clear();
  },
);

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

/** Resolve once at Gateway startup; readers never inspect config or host files. */
export function initializeGatewayResourceProfile(resources: GatewayConfig["resources"]) {
  const previous = getResourceProfile();
  const configured = resources?.profile ?? "auto";
  const memory = readEffectiveMemoryLimit();
  const cpus = os.availableParallelism();
  owner.current = Object.freeze({
    configured,
    ...resolveProfile(configured, memory.memoryLimitBytes),
    ...memory,
    cpus,
  });
  if (owner.current.profile !== previous) {
    notifyListeners(owner.listeners, owner.current.profile);
  }
  return owner.current;
}

/** Resolved host policy; standalone callers retain standard behavior. No host I/O. */
export function getResourceProfile(): ResourceProfile {
  return owner.current?.profile ?? "standard";
}

/** Observe future changes, not an initial snapshot. Unsubscribe when the plugin disposes. */
export function onResourceProfileChange(listener: (profile: ResourceProfile) => void): () => void {
  return registerListener(owner.listeners, listener);
}

/** Undefined outside a running Gateway; do not substitute a CLI process's host facts. */
export function getGatewayResourceProfile(): Readonly<GatewayResourceProfile> | undefined {
  return owner.current;
}
