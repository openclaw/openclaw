import os from "node:os";
import type { GatewayConfig } from "../config/types.gateway.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readEffectiveMemoryLimit } from "./host-memory.js";

export const LEAN_PROFILE_MEMORY_THRESHOLD_BYTES = 8 * 1024 ** 3;

export type GatewayResourceProfile = {
  configured: "auto" | "standard" | "lean";
  profile: "standard" | "lean";
  reason: "explicit" | "memory" | "capacity";
  memoryLimitBytes: number;
  memoryLimitSource: "cgroup-v2" | "host";
  cpus: number;
};

const owner = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayResourceProfile"),
  (): { current?: Readonly<GatewayResourceProfile> } => ({}),
  (state) => {
    state.current = undefined;
  },
);

/** Resolve once at Gateway startup; readers never inspect config or host files. */
export function initializeGatewayResourceProfile(resources: GatewayConfig["resources"]) {
  const configured = resources?.profile ?? "auto";
  const memory = readEffectiveMemoryLimit();
  const cpus = os.availableParallelism();
  const smallMemory = memory.memoryLimitBytes < LEAN_PROFILE_MEMORY_THRESHOLD_BYTES;
  owner.current = Object.freeze({
    configured,
    profile: configured === "auto" ? (smallMemory ? "lean" : "standard") : configured,
    reason: configured !== "auto" ? "explicit" : smallMemory ? "memory" : "capacity",
    ...memory,
    cpus,
  });
  return owner.current;
}

/** Undefined outside a running Gateway; do not substitute a CLI process's host facts. */
export function getGatewayResourceProfile(): Readonly<GatewayResourceProfile> | undefined {
  return owner.current;
}
