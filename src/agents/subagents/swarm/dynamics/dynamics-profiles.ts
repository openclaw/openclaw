import { createHash } from "node:crypto";
import type { DynamicsProfile, ResolvedDynamicsProfile } from "./dynamics-types.js";

const DEFAULT_REQUIREMENTS = {
  sandbox: "inherit",
  candidateDigest: "optional",
  artifactRefs: "optional",
} as const;

const BUILTIN_PROFILES = {
  explorer: {
    version: 1,
    id: "explorer",
    role: "explorer",
    effectiveTemperature: 0.95,
    mutationBudget: 1,
    verificationWeight: 0.05,
    contextBoundary: "isolated",
    requirements: DEFAULT_REQUIREMENTS,
  },
  builder: {
    version: 1,
    id: "builder",
    role: "builder",
    effectiveTemperature: 0.55,
    mutationBudget: 0.55,
    verificationWeight: 0.25,
    contextBoundary: "summary-only",
    requirements: DEFAULT_REQUIREMENTS,
  },
  critic: {
    version: 1,
    id: "critic",
    role: "critic",
    effectiveTemperature: 0.3,
    mutationBudget: 0.2,
    verificationWeight: 0.8,
    contextBoundary: "evidence-only",
    requirements: DEFAULT_REQUIREMENTS,
  },
  "independent-verifier": {
    version: 1,
    id: "independent-verifier",
    role: "verifier",
    effectiveTemperature: 0.08,
    mutationBudget: 0,
    verificationWeight: 1,
    contextBoundary: "artifact-only",
    requirements: {
      sandbox: "require",
      candidateDigest: "required",
      artifactRefs: "required",
    },
  },
  "glass-breaker": {
    version: 1,
    id: "glass-breaker",
    role: "glass-breaker",
    effectiveTemperature: 1,
    mutationBudget: 1,
    verificationWeight: 0.15,
    contextBoundary: "isolated",
    requirements: DEFAULT_REQUIREMENTS,
  },
} as const satisfies Record<string, DynamicsProfile>;

type BuiltinDynamicsProfileId = keyof typeof BUILTIN_PROFILES;

function isBuiltinDynamicsProfileId(id: string): id is BuiltinDynamicsProfileId {
  return Object.hasOwn(BUILTIN_PROFILES, id);
}

function validateProfileContract(profile: DynamicsProfile): void {
  if (
    profile.requirements.artifactRefs === "required" &&
    profile.contextBoundary !== "artifact-only" &&
    profile.contextBoundary !== "fork"
  ) {
    throw new Error("Dynamics profile requires artifacts across a boundary that drops artifacts");
  }
  if (
    profile.requirements.candidateDigest === "required" &&
    profile.contextBoundary === "isolated"
  ) {
    throw new Error("Dynamics profile requires candidate identity across an isolated boundary");
  }
}

function stableProfileInput(profile: DynamicsProfile): string {
  return JSON.stringify({
    contextBoundary: profile.contextBoundary,
    effectiveTemperature: profile.effectiveTemperature,
    id: profile.id,
    mutationBudget: profile.mutationBudget,
    requirements: {
      artifactRefs: profile.requirements.artifactRefs,
      candidateDigest: profile.requirements.candidateDigest,
      sandbox: profile.requirements.sandbox,
    },
    role: profile.role,
    verificationWeight: profile.verificationWeight,
    version: profile.version,
  });
}

export function resolveDynamicsProfile(id: string): ResolvedDynamicsProfile {
  if (typeof id !== "string" || !isBuiltinDynamicsProfileId(id)) {
    throw new Error("Unknown cognitive dynamics profile");
  }
  const profile = BUILTIN_PROFILES[id];
  validateProfileContract(profile);
  const digestInput = stableProfileInput(profile);
  return {
    ...profile,
    digestInput: `sha256:${createHash("sha256").update(digestInput).digest("hex")}`,
  };
}
