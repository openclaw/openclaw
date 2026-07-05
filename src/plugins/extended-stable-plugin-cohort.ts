import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENDED_STABLE_PLUGIN_COHORT_PATH = "release/extended-stable-plugin-cohort.json";

export type ExtendedStablePluginCohort = {
  schemaVersion: 1;
  releaseLine: string;
  baselineVersion: string;
};

const ROOT_KEYS = ["baselineVersion", "releaseLine", "schemaVersion"] as const;
const RELEASE_LINE_RE = /^(?<year>\d{4})\.(?<month>[1-9]|1[0-2])$/u;
const BASELINE_VERSION_RE =
  /^(?<year>\d{4})\.(?<month>[1-9]|1[0-2])\.(?<patch>[1-9]|[12]\d|3[0-2])$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).toSorted();
  return keys.length === ROOT_KEYS.length && keys.every((key, index) => key === ROOT_KEYS[index]);
}

function trimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

export function parseExtendedStablePluginCohort(value: unknown): ExtendedStablePluginCohort {
  if (!isRecord(value) || !exactKeys(value)) {
    throw new Error(`extended-stable plugin cohort must contain exactly: ${ROOT_KEYS.join(", ")}.`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error("extended-stable plugin cohort schemaVersion must be 1.");
  }
  const releaseLine = trimmedString(value.releaseLine, "extended-stable plugin cohort releaseLine");
  const baselineVersion = trimmedString(
    value.baselineVersion,
    "extended-stable plugin cohort baselineVersion",
  );
  const line = RELEASE_LINE_RE.exec(releaseLine)?.groups;
  const baseline = BASELINE_VERSION_RE.exec(baselineVersion)?.groups;
  if (!line) {
    throw new Error("extended-stable plugin cohort releaseLine must match YYYY.M.");
  }
  if (!baseline) {
    throw new Error(
      "extended-stable plugin cohort baselineVersion must be a final YYYY.M.PATCH with patch below 33.",
    );
  }
  if (line.year !== baseline.year || line.month !== baseline.month) {
    throw new Error(
      "extended-stable plugin cohort baselineVersion must use the same release line.",
    );
  }
  return { schemaVersion: 1, releaseLine, baselineVersion };
}

export function loadExtendedStablePluginCohort(rootDir: string): ExtendedStablePluginCohort {
  const path = join(rootDir, EXTENDED_STABLE_PLUGIN_COHORT_PATH);
  try {
    return parseExtendedStablePluginCohort(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    throw new Error(`Could not load ${EXTENDED_STABLE_PLUGIN_COHORT_PATH}: ${String(error)}`, {
      cause: error,
    });
  }
}
