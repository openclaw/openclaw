/** Versioned ownership payload for agent state that predates Claw enrollment. */
import { isStringArray } from "@openclaw/normalization-core/record-coerce";

export const CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION = "openclaw.clawInstallRecord.v3" as const;

export type ClawAgentOrigin = "created" | "adopted";

type AdoptedAgentPaths = {
  origin: "adopted";
  paths: string[];
};

function isAdoptedAgentPaths(value: unknown): value is AdoptedAgentPaths {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!("origin" in value) || !("paths" in value)) {
    return false;
  }
  return value.origin === "adopted" && isStringArray(value.paths);
}

export function decodeClawAgentOwnership(
  value: string,
  schemaVersion: string,
): {
  origin: ClawAgentOrigin;
  paths: string[];
} {
  const parsed: unknown = JSON.parse(value);
  if (schemaVersion === CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION) {
    if (!isAdoptedAgentPaths(parsed)) {
      throw new Error("Adopted Claw install record has invalid agent ownership data.");
    }
    return { origin: "adopted", paths: parsed.paths };
  }
  if (
    schemaVersion !== "openclaw.clawInstallRecord.v1" &&
    schemaVersion !== "openclaw.clawInstallRecord.v2"
  ) {
    throw new Error(`Unsupported Claw install record schema ${JSON.stringify(schemaVersion)}.`);
  }
  if (!isStringArray(parsed)) {
    throw new Error("Created Claw install record has invalid agent ownership data.");
  }
  return { origin: "created", paths: parsed };
}

export function encodeClawAgentOwnership(
  paths: string[],
  origin: ClawAgentOrigin,
): {
  schemaVersion:
    | "openclaw.clawInstallRecord.v2"
    | typeof CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION;
  agentOwnedPathsJson: string;
} {
  return origin === "adopted"
    ? {
        schemaVersion: CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION,
        agentOwnedPathsJson: JSON.stringify({ origin, paths }),
      }
    : {
        schemaVersion: "openclaw.clawInstallRecord.v2",
        agentOwnedPathsJson: JSON.stringify(paths),
      };
}
