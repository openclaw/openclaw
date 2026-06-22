// Validates the checked-in external plugin support surface for the stable line.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isRecord } from "../utils.js";
import {
  getOfficialExternalPluginCatalogEntryForPackage,
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginId,
} from "./official-external-plugin-catalog.js";

export const FIRST_STABLE_PLUGIN_SUPPORT_PACKAGES = [
  "@openclaw/codex",
  "@openclaw/discord",
  "@openclaw/slack",
] as const;

const FIRST_STABLE_LINE_MONTH = "2026.6";
const FIRST_STABLE_LINE_BASE_VERSION = "2026.6.33";
const FIRST_STABLE_TARGET_BRANCH = "stable/2026.6.33";
const STABLE_LINE_VERSION_PATTERN = /^2026\.6\.[1-9][0-9]*$/u;
const EXCLUDED_EXTERNAL_STABLE_PACKAGES = new Set([
  "@openclaw/openai-provider",
  "@openclaw/telegram",
]);
const CODEX_REQUIRED_PLATFORM_PACKAGES = [
  "@openai/codex-linux-x64",
  "@openai/codex-linux-arm64",
  "@openai/codex-darwin-x64",
  "@openai/codex-darwin-arm64",
  "@openai/codex-win32-x64",
  "@openai/codex-win32-arm64",
] as const;

export type StablePluginSupportKind = "channel" | "provider";

export type StablePluginRuntimeHarness = {
  harnessId: string;
  runtimePackage: string;
  installMode: "on_demand_runtime_dependencies";
  requiredPlatformPackages: string[];
};

export type StablePluginSupportEntry = {
  packageName: string;
  pluginId: string;
  kind: StablePluginSupportKind;
  sourceRepository: string;
  packageDir: string;
  stableLine: string;
  targetVersion: string;
  targetNpmSpec: string;
  targetBranch: string;
  runtimeHarness?: StablePluginRuntimeHarness;
  owners: string[];
};

export type StablePluginSupportManifest = {
  schemaVersion: 1;
  stableLine: {
    month: string;
    baseVersion: string;
  };
  coveredPlugins: StablePluginSupportEntry[];
};

export type ValidatedStablePluginSupportManifest = {
  manifest: StablePluginSupportManifest;
  stablePluginSupportSha256: string;
  coveredPackages: string[];
  targetsByPackageName: Map<string, StablePluginSupportEntry>;
};

export function computeStablePluginSupportDigest(manifest: StablePluginSupportManifest): string {
  return createHash("sha256").update(stableJsonStringify(manifest)).digest("hex");
}

export function validateStablePluginSupportManifest(
  raw: unknown,
  options: { repoRoot?: string } = {},
): ValidatedStablePluginSupportManifest {
  const errors: string[] = [];
  const manifest = parseManifest(raw, errors);
  if (!manifest) {
    throw new Error(`Invalid stable plugin support manifest: ${errors.join("; ")}`);
  }

  if (manifest.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (manifest.stableLine.month !== FIRST_STABLE_LINE_MONTH) {
    errors.push(`stableLine.month must be ${FIRST_STABLE_LINE_MONTH}`);
  }
  if (manifest.stableLine.baseVersion !== FIRST_STABLE_LINE_BASE_VERSION) {
    errors.push(`stableLine.baseVersion must be ${FIRST_STABLE_LINE_BASE_VERSION}`);
  }

  const packages = manifest.coveredPlugins.map((entry) => entry.packageName);
  const expectedPackages = [...FIRST_STABLE_PLUGIN_SUPPORT_PACKAGES];
  if (packages.join("\n") !== expectedPackages.join("\n")) {
    errors.push(`coveredPlugins must be exactly ${expectedPackages.join(", ")} in sorted order`);
  }
  if (new Set(packages).size !== packages.length) {
    errors.push("coveredPlugins packageName values must be unique");
  }

  for (const entry of manifest.coveredPlugins) {
    validateStablePluginSupportEntry(entry, errors, options);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid stable plugin support manifest: ${errors.join("; ")}`);
  }

  return {
    manifest,
    stablePluginSupportSha256: computeStablePluginSupportDigest(manifest),
    coveredPackages: packages,
    targetsByPackageName: new Map(
      manifest.coveredPlugins.map((entry) => [entry.packageName, entry]),
    ),
  };
}

function parseManifest(raw: unknown, errors: string[]): StablePluginSupportManifest | null {
  if (!isRecord(raw)) {
    errors.push("manifest must be an object");
    return null;
  }
  rejectUnsupportedProofState(raw, "manifest", errors);
  if (!isRecord(raw.stableLine)) {
    errors.push("stableLine must be an object");
    return null;
  }
  if (!Array.isArray(raw.coveredPlugins)) {
    errors.push("coveredPlugins must be an array");
    return null;
  }
  return {
    schemaVersion: raw.schemaVersion as 1,
    stableLine: {
      month: typeof raw.stableLine.month === "string" ? raw.stableLine.month : "",
      baseVersion: typeof raw.stableLine.baseVersion === "string" ? raw.stableLine.baseVersion : "",
    },
    coveredPlugins: raw.coveredPlugins
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => parseEntry(entry, errors)),
  };
}

function parseEntry(raw: Record<string, unknown>, errors: string[]): StablePluginSupportEntry {
  rejectUnsupportedProofState(raw, `entry ${String(raw.packageName ?? "")}`, errors);
  const runtimeHarness = isRecord(raw.runtimeHarness)
    ? {
        harnessId: stringField(raw.runtimeHarness.harnessId),
        runtimePackage: stringField(raw.runtimeHarness.runtimePackage),
        installMode: raw.runtimeHarness.installMode as "on_demand_runtime_dependencies",
        requiredPlatformPackages: stringArrayField(raw.runtimeHarness.requiredPlatformPackages),
      }
    : undefined;
  return {
    packageName: stringField(raw.packageName),
    pluginId: stringField(raw.pluginId),
    kind: raw.kind === "provider" ? "provider" : "channel",
    sourceRepository: stringField(raw.sourceRepository),
    packageDir: stringField(raw.packageDir),
    stableLine: stringField(raw.stableLine),
    targetVersion: stringField(raw.targetVersion),
    targetNpmSpec: stringField(raw.targetNpmSpec),
    targetBranch: stringField(raw.targetBranch),
    ...(runtimeHarness ? { runtimeHarness } : {}),
    owners: stringArrayField(raw.owners),
  };
}

function validateStablePluginSupportEntry(
  entry: StablePluginSupportEntry,
  errors: string[],
  options: { repoRoot?: string },
): void {
  if (EXCLUDED_EXTERNAL_STABLE_PACKAGES.has(entry.packageName)) {
    errors.push(`${entry.packageName} must not be listed in the external stable support manifest`);
  }
  if (entry.stableLine !== FIRST_STABLE_LINE_MONTH) {
    errors.push(`${entry.packageName} stableLine must be ${FIRST_STABLE_LINE_MONTH}`);
  }
  if (!STABLE_LINE_VERSION_PATTERN.test(entry.targetVersion)) {
    errors.push(
      `${entry.packageName} targetVersion must be an exact ${FIRST_STABLE_LINE_MONTH}.X version`,
    );
  } else {
    const patch = Number(entry.targetVersion.split(".")[2]);
    const basePatch = Number(FIRST_STABLE_LINE_BASE_VERSION.split(".")[2]);
    if (patch < basePatch) {
      errors.push(
        `${entry.packageName} targetVersion must be ${FIRST_STABLE_LINE_BASE_VERSION} or a later stable patch on ${FIRST_STABLE_LINE_MONTH}`,
      );
    }
  }
  if (entry.targetNpmSpec !== `${entry.packageName}@${entry.targetVersion}`) {
    errors.push(`${entry.packageName} targetNpmSpec must be exact package@targetVersion`);
  }
  const parsedTarget = parseRegistryNpmSpec(entry.targetNpmSpec);
  if (
    !parsedTarget ||
    parsedTarget.name !== entry.packageName ||
    parsedTarget.selectorKind !== "exact-version" ||
    parsedTarget.selector !== entry.targetVersion
  ) {
    errors.push(`${entry.packageName} targetNpmSpec must parse as an exact npm version`);
  }
  if (entry.targetBranch !== FIRST_STABLE_TARGET_BRANCH) {
    errors.push(`${entry.packageName} targetBranch must be ${FIRST_STABLE_TARGET_BRANCH}`);
  }
  if (!/^openclaw\/[^/\s]+$/u.test(entry.sourceRepository)) {
    errors.push(`${entry.packageName} sourceRepository must be under openclaw/*`);
  }
  if (entry.sourceRepository === "openclaw/openclaw" && options.repoRoot) {
    const packageDir = path.join(options.repoRoot, entry.packageDir);
    if (!fs.existsSync(packageDir)) {
      errors.push(`${entry.packageName} packageDir does not exist: ${entry.packageDir}`);
    }
  }
  validateCatalogMapping(entry, errors);
  if (entry.packageName === "@openclaw/codex") {
    validateCodexRuntimeHarness(entry, errors);
  } else if (entry.runtimeHarness) {
    errors.push(`${entry.packageName} must not declare runtimeHarness`);
  }
}

function validateCatalogMapping(entry: StablePluginSupportEntry, errors: string[]): void {
  const catalogEntry = getOfficialExternalPluginCatalogEntryForPackage(entry.packageName);
  if (!catalogEntry) {
    errors.push(`${entry.packageName} is not present in the official external catalog`);
    return;
  }
  const catalogPluginId = resolveOfficialExternalPluginId(catalogEntry);
  if (catalogPluginId !== entry.pluginId) {
    errors.push(`${entry.packageName} pluginId must match official catalog id ${catalogPluginId}`);
  }
  const catalogManifest = getOfficialExternalPluginCatalogManifest(catalogEntry);
  const catalogKind = catalogManifest?.channel
    ? "channel"
    : (catalogManifest?.providers?.length ?? 0) > 0
      ? "provider"
      : undefined;
  if (catalogKind !== entry.kind) {
    errors.push(`${entry.packageName} kind must match official catalog kind ${catalogKind}`);
  }
}

function validateCodexRuntimeHarness(entry: StablePluginSupportEntry, errors: string[]): void {
  const runtimeHarness = entry.runtimeHarness;
  if (!runtimeHarness) {
    errors.push("@openclaw/codex must declare runtimeHarness");
    return;
  }
  if (runtimeHarness.harnessId !== "codex") {
    errors.push("@openclaw/codex runtimeHarness.harnessId must be codex");
  }
  if (runtimeHarness.runtimePackage !== "@openai/codex") {
    errors.push("@openclaw/codex runtimeHarness.runtimePackage must be @openai/codex");
  }
  if (runtimeHarness.installMode !== "on_demand_runtime_dependencies") {
    errors.push("@openclaw/codex runtimeHarness.installMode is invalid");
  }
  const expectedPlatformPackages = [...CODEX_REQUIRED_PLATFORM_PACKAGES];
  if (runtimeHarness.requiredPlatformPackages.join("\n") !== expectedPlatformPackages.join("\n")) {
    errors.push(
      "@openclaw/codex runtimeHarness.requiredPlatformPackages must match Codex manifest",
    );
  }
}

function rejectUnsupportedProofState(
  value: Record<string, unknown>,
  label: string,
  errors: string[],
): void {
  if ("supportState" in value) {
    errors.push(`${label} must not include supportState`);
  }
  if ("requiredProof" in value) {
    errors.push(`${label} must not include requiredProof`);
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
