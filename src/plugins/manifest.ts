import fs from "node:fs";
import path from "node:path";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import type { PluginConfigUiHint, PluginKind } from "./types.js";

export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
export const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME] as const;

export type PluginManifest = {
  id: string;
  configSchema: Record<string, unknown>;
  kind?: PluginKind;
  channels?: string[];
  providers?: string[];
  /** Cheap provider-auth env lookup without booting plugin runtime. */
  providerAuthEnvVars?: Record<string, string[]>;
  /**
   * Cheap onboarding/auth-choice metadata used by config validation, CLI help,
   * and non-runtime auth-choice routing before provider runtime loads.
   */
  providerAuthChoices?: PluginManifestProviderAuthChoice[];
  skills?: string[];
  name?: string;
  description?: string;
  version?: string;
  uiHints?: Record<string, PluginConfigUiHint>;
};

export type PluginManifestProviderAuthChoice = {
  /** Provider id owned by this manifest entry. */
  provider: string;
  /** Provider auth method id that this choice should dispatch to. */
  method: string;
  /** Stable auth-choice id used by onboarding and other CLI auth flows. */
  choiceId: string;
  /** Optional user-facing choice label/hint for grouped onboarding UI. */
  choiceLabel?: string;
  choiceHint?: string;
  /** Optional grouping metadata for auth-choice pickers. */
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  /** Optional CLI flag metadata for one-flag auth flows such as API keys. */
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
};

export type PluginManifestLoadResult =
  | { ok: true; manifest: PluginManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function normalizeStringListRecord(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, string[]> = {};
  for (const [key, rawValues] of Object.entries(value)) {
    const providerId = typeof key === "string" ? key.trim() : "";
    if (!providerId) {
      continue;
    }
    const values = normalizeStringList(rawValues);
    if (values.length === 0) {
      continue;
    }
    normalized[providerId] = values;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeProviderAuthChoices(
  value: unknown,
): PluginManifestProviderAuthChoice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestProviderAuthChoice[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    const method = typeof entry.method === "string" ? entry.method.trim() : "";
    const choiceId = typeof entry.choiceId === "string" ? entry.choiceId.trim() : "";
    if (!provider || !method || !choiceId) {
      continue;
    }
    const choiceLabel = typeof entry.choiceLabel === "string" ? entry.choiceLabel.trim() : "";
    const choiceHint = typeof entry.choiceHint === "string" ? entry.choiceHint.trim() : "";
    const groupId = typeof entry.groupId === "string" ? entry.groupId.trim() : "";
    const groupLabel = typeof entry.groupLabel === "string" ? entry.groupLabel.trim() : "";
    const groupHint = typeof entry.groupHint === "string" ? entry.groupHint.trim() : "";
    const optionKey = typeof entry.optionKey === "string" ? entry.optionKey.trim() : "";
    const cliFlag = typeof entry.cliFlag === "string" ? entry.cliFlag.trim() : "";
    const cliOption = typeof entry.cliOption === "string" ? entry.cliOption.trim() : "";
    const cliDescription =
      typeof entry.cliDescription === "string" ? entry.cliDescription.trim() : "";
    normalized.push({
      provider,
      method,
      choiceId,
      ...(choiceLabel ? { choiceLabel } : {}),
      ...(choiceHint ? { choiceHint } : {}),
      ...(groupId ? { groupId } : {}),
      ...(groupLabel ? { groupLabel } : {}),
      ...(groupHint ? { groupHint } : {}),
      ...(optionKey ? { optionKey } : {}),
      ...(cliFlag ? { cliFlag } : {}),
      ...(cliOption ? { cliOption } : {}),
      ...(cliDescription ? { cliDescription } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function resolvePluginManifestPath(rootDir: string): string {
  for (const filename of PLUGIN_MANIFEST_FILENAMES) {
    const candidate = path.join(rootDir, filename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}

export function loadPluginManifest(
  rootDir: string,
  rejectHardlinks = true,
): PluginManifestLoadResult {
  const manifestPath = resolvePluginManifestPath(rootDir);
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks,
  });
  if (!opened.ok) {
    if (opened.reason === "path") {
      return { ok: false, error: `plugin manifest not found: ${manifestPath}`, manifestPath };
    }
    return {
      ok: false,
      error: `unsafe plugin manifest path: ${manifestPath} (${opened.reason})`,
      manifestPath,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse plugin manifest: ${String(err)}`,
      manifestPath,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
  if (!isRecord(raw)) {
    return { ok: false, error: "plugin manifest must be an object", manifestPath };
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    return { ok: false, error: "plugin manifest requires id", manifestPath };
  }
  const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
  if (!configSchema) {
    return { ok: false, error: "plugin manifest requires configSchema", manifestPath };
  }

  const kind = typeof raw.kind === "string" ? (raw.kind as PluginKind) : undefined;
  const name = typeof raw.name === "string" ? raw.name.trim() : undefined;
  const description = typeof raw.description === "string" ? raw.description.trim() : undefined;
  const version = typeof raw.version === "string" ? raw.version.trim() : undefined;
  const channels = normalizeStringList(raw.channels);
  const providers = normalizeStringList(raw.providers);
  const providerAuthEnvVars = normalizeStringListRecord(raw.providerAuthEnvVars);
  const providerAuthChoices = normalizeProviderAuthChoices(raw.providerAuthChoices);
  const skills = normalizeStringList(raw.skills);

  let uiHints: Record<string, PluginConfigUiHint> | undefined;
  if (isRecord(raw.uiHints)) {
    uiHints = raw.uiHints as Record<string, PluginConfigUiHint>;
  }

  return {
    ok: true,
    manifest: {
      id,
      configSchema,
      kind,
      channels,
      providers,
      providerAuthEnvVars,
      providerAuthChoices,
      skills,
      name,
      description,
      version,
      uiHints,
    },
    manifestPath,
  };
}

// package.json "openclaw" metadata (used for setup/catalog)
export type PluginPackageChannel = {
  id?: string;
  label?: string;
  selectionLabel?: string;
  detailLabel?: string;
  docsPath?: string;
  docsLabel?: string;
  blurb?: string;
  order?: number;
  aliases?: string[];
  preferOver?: string[];
  systemImage?: string;
  selectionDocsPrefix?: string;
  selectionDocsOmitLabel?: boolean;
  selectionExtras?: string[];
  showConfigured?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
};

export type PluginPackageInstall = {
  npmSpec?: string;
  localPath?: string;
  defaultChoice?: "npm" | "local";
};

export type OpenClawPackageManifest = {
  extensions?: string[];
  setupEntry?: string;
  channel?: PluginPackageChannel;
  install?: PluginPackageInstall;
};

export const DEFAULT_PLUGIN_ENTRY_CANDIDATES = [
  "index.ts",
  "index.js",
  "index.mjs",
  "index.cjs",
] as const;

export type PackageExtensionResolution =
  | { status: "ok"; entries: string[] }
  | { status: "missing"; entries: [] }
  | { status: "empty"; entries: [] };

export type ManifestKey = typeof MANIFEST_KEY;

export type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
} & Partial<Record<ManifestKey, OpenClawPackageManifest>>;

export function getPackageManifestMetadata(
  manifest: PackageManifest | undefined,
): OpenClawPackageManifest | undefined {
  if (!manifest) {
    return undefined;
  }
  return manifest[MANIFEST_KEY];
}

export function resolvePackageExtensionEntries(
  manifest: PackageManifest | undefined,
): PackageExtensionResolution {
  const raw = getPackageManifestMetadata(manifest)?.extensions;
  if (!Array.isArray(raw)) {
    return { status: "missing", entries: [] };
  }
  const entries = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (entries.length === 0) {
    return { status: "empty", entries: [] };
  }
  return { status: "ok", entries };
}
