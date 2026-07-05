// Loads the human-owned extended-stable plugin support policy from a core package.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENDED_STABLE_PLUGIN_SUPPORT_PATH = "release/extended-stable-plugin-support.json";

export type ExtendedStablePluginSupportEntry = {
  pluginId: string;
  packageName: string;
  packageDir: string;
  acceptanceProfile: string;
};

export type ExtendedStablePluginSupport = {
  schemaVersion: 1;
  plugins: ExtendedStablePluginSupportEntry[];
};

const ACCEPTANCE_PROFILES = new Set([
  "codex-provider-v1",
  "discord-channel-v1",
  "slack-channel-v1",
]);
const ROOT_KEYS = ["plugins", "schemaVersion"] as const;
const ENTRY_KEYS = ["acceptanceProfile", "packageDir", "packageName", "pluginId"] as const;
const REQUIRED_SUPPORT_ENTRIES: readonly ExtendedStablePluginSupportEntry[] = [
  {
    pluginId: "codex",
    packageName: "@openclaw/codex",
    packageDir: "extensions/codex",
    acceptanceProfile: "codex-provider-v1",
  },
  {
    pluginId: "discord",
    packageName: "@openclaw/discord",
    packageDir: "extensions/discord",
    acceptanceProfile: "discord-channel-v1",
  },
  {
    pluginId: "slack",
    packageName: "@openclaw/slack",
    packageDir: "extensions/slack",
    acceptanceProfile: "slack-channel-v1",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).toSorted();
  const expected = [...expectedKeys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty, trimmed string.`);
  }
  return value;
}

function parseEntry(value: unknown, index: number): ExtendedStablePluginSupportEntry {
  const label = `extended-stable plugin support entry ${index}`;
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertExactKeys(value, ENTRY_KEYS, label);
  const entry = {
    pluginId: requireString(value.pluginId, `${label}.pluginId`),
    packageName: requireString(value.packageName, `${label}.packageName`),
    packageDir: requireString(value.packageDir, `${label}.packageDir`),
    acceptanceProfile: requireString(value.acceptanceProfile, `${label}.acceptanceProfile`),
  };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.pluginId)) {
    throw new Error(`${label}.pluginId must be a safe lowercase plugin id.`);
  }
  if (entry.packageName !== `@openclaw/${entry.pluginId}`) {
    throw new Error(`${label}.packageName must match pluginId.`);
  }
  if (entry.packageDir !== `extensions/${entry.pluginId}`) {
    throw new Error(`${label}.packageDir must match pluginId.`);
  }
  if (!ACCEPTANCE_PROFILES.has(entry.acceptanceProfile)) {
    throw new Error(`${label}.acceptanceProfile is not registered.`);
  }
  return entry;
}

export function parseExtendedStablePluginSupport(value: unknown): ExtendedStablePluginSupport {
  if (!isRecord(value)) {
    throw new Error("extended-stable plugin support policy must be an object.");
  }
  assertExactKeys(value, ROOT_KEYS, "extended-stable plugin support policy");
  if (value.schemaVersion !== 1) {
    throw new Error("extended-stable plugin support policy schemaVersion must be 1.");
  }
  if (!Array.isArray(value.plugins)) {
    throw new Error("extended-stable plugin support policy plugins must be an array.");
  }
  const plugins = value.plugins.map(parseEntry);
  for (const key of ["pluginId", "packageName", "packageDir"] as const) {
    const values = plugins.map((entry) => entry[key]);
    if (new Set(values).size !== values.length) {
      throw new Error(`extended-stable plugin support entries must have unique ${key} values.`);
    }
  }
  const sortedPackageNames = plugins.map((entry) => entry.packageName).toSorted();
  if (plugins.some((entry, index) => entry.packageName !== sortedPackageNames[index])) {
    throw new Error("extended-stable plugin support entries must be sorted by packageName.");
  }
  if (JSON.stringify(plugins) !== JSON.stringify(REQUIRED_SUPPORT_ENTRIES)) {
    throw new Error(
      "extended-stable plugin support must contain exactly codex, discord, and slack with their registered acceptance profiles.",
    );
  }
  return { schemaVersion: 1, plugins };
}

export function loadExtendedStablePluginSupport(rootDir: string): ExtendedStablePluginSupport {
  const policyPath = join(rootDir, EXTENDED_STABLE_PLUGIN_SUPPORT_PATH);
  try {
    return parseExtendedStablePluginSupport(JSON.parse(readFileSync(policyPath, "utf8")));
  } catch (error) {
    throw new Error(`Could not read ${EXTENDED_STABLE_PLUGIN_SUPPORT_PATH}: ${String(error)}`, {
      cause: error,
    });
  }
}
