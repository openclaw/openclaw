import fs from "node:fs";
import path from "node:path";

/** Align with Maibot `WORKSPACE_INDEXING_MIRROR_SCHEMA_VERSION` (maibot-ui). */
export const MAIBOT_INDEXING_PREFS_SCHEMA_VERSION = 1 as const;

const MAX_FILE_BYTES = 256_000;
const IGNORE_LINES_MAX = 64;

const REL_SEGMENTS = [".maibot", "indexing", "preferences.json"] as const;

export type MaibotIndexingPreferencesFile = {
  schemaVersion: number;
  updatedAt: string;
  preferences: {
    indexNewFolders: boolean;
    instantGrep: boolean;
    ignorePatternsRaw: string;
    ignorePatternLines: string[];
  };
  effectiveWorkspace: {
    primaryRoot: string;
    additionalRoots: string[];
    source: string;
    workbenchProject?: { id: string; name: string; gatewayProjectId?: string };
  };
};

/** Subset surfaced on `hello.ok.snapshot` (OpenClaw gateway). */
export type MaibotWorkspaceIndexingHelloSnapshot = {
  schemaVersion: number;
  updatedAt: string;
  indexNewFolders: boolean;
  instantGrep: boolean;
  ignorePatternLines: string[];
  effectiveWorkspacePrimaryRoot: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }
    out.push(item);
  }
  return out;
}

function validatePayload(raw: unknown): MaibotIndexingPreferencesFile | null {
  if (!isRecord(raw)) {
    return null;
  }
  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== MAIBOT_INDEXING_PREFS_SCHEMA_VERSION) {
    return null;
  }
  const updatedAt = asString(raw.updatedAt)?.trim();
  if (!updatedAt) {
    return null;
  }
  const prefs = raw.preferences;
  if (!isRecord(prefs)) {
    return null;
  }
  const indexNewFolders = asBoolean(prefs.indexNewFolders);
  const instantGrep = asBoolean(prefs.instantGrep);
  const ignorePatternsRaw = asString(prefs.ignorePatternsRaw) ?? "";
  const ignorePatternLines = asStringArray(prefs.ignorePatternLines) ?? [];
  if (indexNewFolders === undefined || instantGrep === undefined) {
    return null;
  }
  const eff = raw.effectiveWorkspace;
  if (!isRecord(eff)) {
    return null;
  }
  const primaryRoot = asString(eff.primaryRoot)?.trim();
  if (!primaryRoot) {
    return null;
  }
  const additionalRoots = asStringArray(eff.additionalRoots) ?? [];
  const source = asString(eff.source)?.trim();
  if (!source) {
    return null;
  }
  let workbenchProject: MaibotIndexingPreferencesFile["effectiveWorkspace"]["workbenchProject"];
  if (eff.workbenchProject !== undefined) {
    if (!isRecord(eff.workbenchProject)) {
      return null;
    }
    const id = asString(eff.workbenchProject.id)?.trim();
    const name = asString(eff.workbenchProject.name)?.trim();
    if (!id || !name) {
      return null;
    }
    const gatewayProjectId = asString(eff.workbenchProject.gatewayProjectId)?.trim();
    workbenchProject = { id, name, ...(gatewayProjectId ? { gatewayProjectId } : {}) };
  }

  return {
    schemaVersion: MAIBOT_INDEXING_PREFS_SCHEMA_VERSION,
    updatedAt,
    preferences: {
      indexNewFolders,
      instantGrep,
      ignorePatternsRaw,
      ignorePatternLines,
    },
    effectiveWorkspace: {
      primaryRoot,
      additionalRoots,
      source,
      ...(workbenchProject ? { workbenchProject } : {}),
    },
  };
}

export type ReadMaibotIndexingPreferencesResult =
  | { ok: true; absolutePath: string; data: MaibotIndexingPreferencesFile }
  | { ok: false; absolutePath: string; reason: string };

/**
 * Read Maibot desktop–mirrored indexing preferences from
 * `<workspace>/.maibot/indexing/preferences.json`.
 *
 * Written by Maibot UI (Tauri) when the effective primary workspace is a local path; validated here for `hello.ok.snapshot`.
 */
export function readMaibotIndexingPreferencesFromWorkspace(
  workspaceRootAbs: string,
): ReadMaibotIndexingPreferencesResult {
  const base = path.resolve(workspaceRootAbs);
  const absolutePath = path.join(base, ...REL_SEGMENTS);
  try {
    const st = fs.statSync(absolutePath);
    if (!st.isFile()) {
      return { ok: false, absolutePath, reason: "not_a_file" };
    }
    if (st.size > MAX_FILE_BYTES) {
      return { ok: false, absolutePath, reason: "file_too_large" };
    }
    const text = fs.readFileSync(absolutePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, absolutePath, reason: "invalid_json" };
    }
    const data = validatePayload(parsed);
    if (!data) {
      return { ok: false, absolutePath, reason: "schema_mismatch" };
    }
    return { ok: true, absolutePath, data };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { ok: false, absolutePath, reason: "missing" };
    }
    return { ok: false, absolutePath, reason: "read_failed" };
  }
}

export function toMaibotWorkspaceIndexingHelloSnapshot(
  data: MaibotIndexingPreferencesFile,
): MaibotWorkspaceIndexingHelloSnapshot {
  const lines = data.preferences.ignorePatternLines.filter((l) => l.trim().length > 0);
  return {
    schemaVersion: data.schemaVersion,
    updatedAt: data.updatedAt,
    indexNewFolders: data.preferences.indexNewFolders,
    instantGrep: data.preferences.instantGrep,
    ignorePatternLines: lines.slice(0, IGNORE_LINES_MAX),
    effectiveWorkspacePrimaryRoot: data.effectiveWorkspace.primaryRoot,
  };
}
