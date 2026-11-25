/** Versioned ownership payload for agent state that predates Template enrollment. */
import { isStringArray } from "@openclaw/normalization-core/record-coerce";

export const TEMPLATE_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION =
  "openclaw.templateInstallRecord.v3" as const;

export type TemplateAgentOrigin = "created" | "adopted";

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

export function decodeTemplateAgentOwnership(
  value: string,
  schemaVersion: string,
): {
  origin: TemplateAgentOrigin;
  paths: string[];
} {
  const parsed: unknown = JSON.parse(value);
  if (schemaVersion === TEMPLATE_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION) {
    if (!isAdoptedAgentPaths(parsed)) {
      throw new Error("Adopted Template install record has invalid agent ownership data.");
    }
    return { origin: "adopted", paths: parsed.paths };
  }
  if (
    schemaVersion !== "openclaw.templateInstallRecord.v1" &&
    schemaVersion !== "openclaw.templateInstallRecord.v2"
  ) {
    throw new Error(`Unsupported Template install record schema ${JSON.stringify(schemaVersion)}.`);
  }
  if (!isStringArray(parsed)) {
    throw new Error("Created Template install record has invalid agent ownership data.");
  }
  return { origin: "created", paths: parsed };
}
