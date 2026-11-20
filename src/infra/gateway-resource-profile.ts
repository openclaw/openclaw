import os from "node:os";
import type { GatewayConfig } from "../config/types.gateway.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readEffectiveMemoryLimit } from "./host-memory.js";

// Provisional thresholds; calibrate against measured small-host workloads.
export const LEAN_PROFILE_MEMORY_THRESHOLD_BYTES = 2 * 1024 ** 3;
export const LEAN_PROFILE_CPU_THRESHOLD = 2;

export type GatewayResourceProfile = {
  configured: "auto" | "standard" | "lean";
  profile: "standard" | "lean";
  reason: "explicit" | "memory" | "cpus" | "memory-and-cpus" | "capacity";
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
  const smallMemory = memory.memoryLimitBytes <= LEAN_PROFILE_MEMORY_THRESHOLD_BYTES;
  const smallCpu = cpus <= LEAN_PROFILE_CPU_THRESHOLD;
  owner.current = Object.freeze({
    configured,
    profile: configured === "auto" ? (smallMemory || smallCpu ? "lean" : "standard") : configured,
    reason:
      configured !== "auto"
        ? "explicit"
        : smallMemory && smallCpu
          ? "memory-and-cpus"
          : smallMemory
            ? "memory"
            : smallCpu
              ? "cpus"
              : "capacity",
    ...memory,
    cpus,
  });
  return owner.current;
}

/** Undefined outside a running Gateway; do not substitute a CLI process's host facts. */
export function getGatewayResourceProfile(): Readonly<GatewayResourceProfile> | undefined {
  return owner.current;
}
