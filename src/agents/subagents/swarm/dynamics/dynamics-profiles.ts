import { createHash } from "node:crypto";
import type { DynamicsProfile, ResolvedDynamicsProfile } from "./dynamics-types.js";

const BUILTIN_PROFILES = {
  explorer: {
    version: 1,
    id: "explorer",
    role: "explorer",
    effectiveTemperature: 0.95,
    mutationBudget: 1,
    verificationWeight: 0.05,
    contextBoundary: "isolated",
  },
  builder: {
    version: 1,
    id: "builder",
    role: "builder",
    effectiveTemperature: 0.55,
    mutationBudget: 0.55,
    verificationWeight: 0.25,
    contextBoundary: "summary-only",
  },
  critic: {
    version: 1,
    id: "critic",
    role: "critic",
    effectiveTemperature: 0.3,
    mutationBudget: 0.2,
    verificationWeight: 0.8,
    contextBoundary: "evidence-only",
  },
  "independent-verifier": {
    version: 1,
    id: "independent-verifier",
    role: "verifier",
    effectiveTemperature: 0.08,
    mutationBudget: 0,
    verificationWeight: 1,
    contextBoundary: "artifact-only",
  },
  "glass-breaker": {
    version: 1,
    id: "glass-breaker",
    role: "glass-breaker",
    effectiveTemperature: 1,
    mutationBudget: 1,
    verificationWeight: 0.15,
    contextBoundary: "isolated",
  },
} as const satisfies Record<string, DynamicsProfile>;

type BuiltinDynamicsProfileId = keyof typeof BUILTIN_PROFILES;

function stableProfileInput(profile: DynamicsProfile): string {
  return JSON.stringify({
    contextBoundary: profile.contextBoundary,
    effectiveTemperature: profile.effectiveTemperature,
    id: profile.id,
    mutationBudget: profile.mutationBudget,
    role: profile.role,
    verificationWeight: profile.verificationWeight,
    version: profile.version,
  });
}

export function resolveDynamicsProfile(id: string): ResolvedDynamicsProfile {
  if (typeof id !== "string" || !Object.hasOwn(BUILTIN_PROFILES, id)) {
    throw new Error("Unknown cognitive dynamics profile");
  }
  // SAFETY: Object.hasOwn above proves id is an own key of BUILTIN_PROFILES.
  const profile = BUILTIN_PROFILES[id as BuiltinDynamicsProfileId];
  const digestInput = stableProfileInput(profile);
  return {
    ...profile,
    digestInput: `sha256:${createHash("sha256").update(digestInput).digest("hex")}`,
  };
}
