import type { PluginManifest } from "./plugin-adapter.types.js";

export type PluginManifestValidationResult =
  | {
      ok: true;
      manifest: PluginManifest;
    }
  | {
      ok: false;
      errors: string[];
    };

const pluginRiskLevels = new Set(["low", "medium", "high"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasOptionalString(
  manifest: Record<string, unknown>,
  key: keyof Pick<PluginManifest, "description">,
): boolean {
  return manifest[key] === undefined || typeof manifest[key] === "string";
}

function hasOptionalBoolean(
  manifest: Record<string, unknown>,
  key: keyof Pick<PluginManifest, "enabledByDefault">,
): boolean {
  return manifest[key] === undefined || typeof manifest[key] === "boolean";
}

export function validatePluginManifest(value: unknown): PluginManifestValidationResult {
  if (!isRecord(value)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }

  const errors: string[] = [];

  if (typeof value.name !== "string" || value.name.length === 0) {
    errors.push("manifest.name must be a non-empty string");
  }
  if (!isStringArray(value.capabilities)) {
    errors.push("manifest.capabilities must be an array of strings");
  }
  if (typeof value.entrypoint !== "string" || value.entrypoint.length === 0) {
    errors.push("manifest.entrypoint must be a non-empty string");
  }
  if (!hasOptionalString(value, "description")) {
    errors.push("manifest.description must be a string when provided");
  }
  if (!hasOptionalBoolean(value, "enabledByDefault")) {
    errors.push("manifest.enabledByDefault must be a boolean when provided");
  }
  if (value.riskLevel !== undefined && !pluginRiskLevels.has(String(value.riskLevel))) {
    errors.push("manifest.riskLevel must be low, medium, or high when provided");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, manifest: value as PluginManifest };
}
