import { readFileSync } from "node:fs";
import YAML from "yaml";
import { scenarioConfigSchema } from "./scenario.schema.js";
import type { ScenarioConfig } from "./types.js";

/**
 * Load and validate a scenario YAML file.
 * Uses strict YAML parsing (core schema, unique keys) to prevent
 * merge-key attacks (CVE-2025-64718 in js-yaml).
 */
export function loadScenario(filePath: string): ScenarioConfig {
  const raw = readFileSync(filePath, "utf-8");
  return parseScenario(raw);
}

/** Parse and validate scenario YAML content (for testing / inline use). */
export function parseScenario(yamlContent: string): ScenarioConfig {
  const parsed: unknown = YAML.parse(yamlContent, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  return scenarioConfigSchema.parse(parsed);
}

/**
 * Derive a new scenario from a base by applying overrides.
 * Useful for parameter sweeps (e.g. varying maxConcurrent).
 */
export function deriveScenario(
  base: ScenarioConfig,
  overrides: Partial<ScenarioConfig>,
): ScenarioConfig {
  const merged = { ...base, ...overrides };
  // Re-validate to catch invalid overrides
  return scenarioConfigSchema.parse(merged);
}
