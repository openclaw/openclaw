import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeTrimmedStringList } from "../shared/string-normalization.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import { safeParseJsonWithSchema, safeParseWithSchema } from "../utils/zod-parse.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const LEGACY_MANIFEST_CONTRACT_KEYS = [
  "speechProviders",
  "mediaUnderstandingProviders",
  "imageGenerationProviders",
  "tools",
] as const;

export type LegacyManifestContractMigration = {
  manifestPath: string;
  pluginId: string;
  nextRaw: Record<string, unknown>;
  changeLines: string[];
};

export type LegacyPluginManifestContractRepairResult = {
  status?: "repaired" | "skipped" | "failed";
  changes: string[];
  warnings: string[];
  diffs: {
    kind: "file";
    path: string;
    before?: string;
    after?: string;
  }[];
  effects: {
    kind: "file";
    action: string;
    target: string;
    dryRunSafe: boolean;
  }[];
};

const JsonRecordSchema = z.record(z.string(), z.unknown());

function readManifestJson(manifestPath: string): Record<string, unknown> | null {
  try {
    return safeParseJsonWithSchema(JsonRecordSchema, fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
}

function renderManifestJson(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

function manifestSeenKey(manifestPath: string): string {
  try {
    return fs.realpathSync.native(manifestPath);
  } catch {
    return path.resolve(manifestPath);
  }
}

function collectManifestMigration(params: {
  manifestPath: string;
  seen: Set<string>;
  migrations: LegacyManifestContractMigration[];
}): void {
  const seenKey = manifestSeenKey(params.manifestPath);
  if (params.seen.has(seenKey)) {
    return;
  }
  params.seen.add(seenKey);
  const raw = readManifestJson(params.manifestPath);
  if (!raw) {
    return;
  }
  const migration = buildLegacyManifestContractMigration({
    manifestPath: params.manifestPath,
    raw,
  });
  if (migration) {
    params.migrations.push(migration);
  }
}

function buildLegacyManifestContractMigration(params: {
  manifestPath: string;
  raw: Record<string, unknown>;
}): LegacyManifestContractMigration | null {
  const nextRaw = { ...params.raw };
  const parsedContracts = safeParseWithSchema(JsonRecordSchema, params.raw.contracts);
  const nextContracts = parsedContracts ? { ...parsedContracts } : {};
  const changeLines: string[] = [];

  for (const key of LEGACY_MANIFEST_CONTRACT_KEYS) {
    if (!(key in params.raw)) {
      continue;
    }
    const legacyValues = normalizeTrimmedStringList(params.raw[key]);
    const contractValues = normalizeTrimmedStringList(nextContracts[key]);
    if (legacyValues.length > 0 && contractValues.length === 0) {
      nextContracts[key] = legacyValues;
      changeLines.push(
        `- ${shortenHomePath(params.manifestPath)}: moved ${key} to contracts.${key}`,
      );
    } else {
      changeLines.push(
        `- ${shortenHomePath(params.manifestPath)}: removed legacy ${key} (kept contracts.${key})`,
      );
    }
    delete nextRaw[key];
  }

  if (changeLines.length === 0) {
    return null;
  }

  if (Object.keys(nextContracts).length > 0) {
    nextRaw.contracts = nextContracts;
  } else {
    delete nextRaw.contracts;
  }

  const pluginId = normalizeOptionalString(params.raw.id) ?? params.manifestPath;
  return {
    manifestPath: params.manifestPath,
    pluginId,
    nextRaw,
    changeLines,
  };
}

export function collectLegacyPluginManifestContractMigrations(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRoots?: string[];
  workspaceDir?: string;
}): LegacyManifestContractMigration[] {
  const seen = new Set<string>();
  const migrations: LegacyManifestContractMigration[] = [];

  for (const root of params?.manifestRoots ?? []) {
    let rootStat: fs.Stats;
    try {
      rootStat = fs.statSync(root);
    } catch {
      continue;
    }
    if (rootStat.isFile()) {
      collectManifestMigration({ manifestPath: root, seen, migrations });
      continue;
    }
    if (!rootStat.isDirectory()) {
      continue;
    }
    collectManifestMigration({
      manifestPath: path.join(root, "openclaw.plugin.json"),
      seen,
      migrations,
    });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(root, entry.name, "openclaw.plugin.json");
      collectManifestMigration({ manifestPath, seen, migrations });
    }
  }

  for (const plugin of loadPluginManifestRegistry({
    ...(params?.config ? { config: params.config } : {}),
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  }).plugins) {
    collectManifestMigration({
      manifestPath: plugin.manifestPath,
      seen,
      migrations,
    });
  }

  return migrations.toSorted((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

export async function repairLegacyPluginManifestContracts(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRoots?: string[];
  workspaceDir?: string;
  runtime: RuntimeEnv;
  migrations?: readonly LegacyManifestContractMigration[];
  dryRun?: boolean;
  diff?: boolean;
}): Promise<LegacyPluginManifestContractRepairResult> {
  const migrations =
    params.migrations ??
    collectLegacyPluginManifestContractMigrations({
      ...(params.config ? { config: params.config } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...(params.manifestRoots ? { manifestRoots: params.manifestRoots } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  if (migrations.length === 0) {
    return { status: "skipped", changes: [], warnings: [], diffs: [], effects: [] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const diffs: LegacyPluginManifestContractRepairResult["diffs"] = [];
  const effects: LegacyPluginManifestContractRepairResult["effects"] = [];

  for (const migration of migrations) {
    const after = renderManifestJson(migration.nextRaw);
    if (params.diff === true) {
      let before: string | undefined;
      try {
        before = fs.readFileSync(migration.manifestPath, "utf-8");
      } catch {
        before = undefined;
      }
      diffs.push({
        kind: "file",
        path: migration.manifestPath,
        ...(before !== undefined ? { before } : {}),
        after,
      });
    }
    const effect: LegacyPluginManifestContractRepairResult["effects"][number] = {
      kind: "file",
      action:
        params.dryRun === true
          ? "would-rewrite-legacy-plugin-manifest-contracts"
          : "rewrite-legacy-plugin-manifest-contracts",
      target: migration.manifestPath,
      dryRunSafe: params.dryRun === true,
    };
    if (params.dryRun === true) {
      effects.push(effect);
      changes.push(...migration.changeLines);
      continue;
    }
    try {
      fs.writeFileSync(migration.manifestPath, after, "utf-8");
      effects.push(effect);
      changes.push(...migration.changeLines);
    } catch (error) {
      const warning = `Failed to rewrite legacy plugin manifest at ${migration.manifestPath}: ${String(error)}`;
      warnings.push(warning);
      params.runtime.error(warning);
    }
  }

  return {
    status: warnings.length === migrations.length ? "failed" : "repaired",
    changes,
    warnings,
    diffs,
    effects,
  };
}

export async function maybeRepairLegacyPluginManifestContracts(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRoots?: string[];
  workspaceDir?: string;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  note?: typeof note;
}): Promise<void> {
  const migrations = collectLegacyPluginManifestContractMigrations({
    ...(params.config ? { config: params.config } : {}),
    ...(params.env ? { env: params.env } : {}),
    ...(params.manifestRoots ? { manifestRoots: params.manifestRoots } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (migrations.length === 0) {
    return;
  }

  const emitNote = params.note ?? note;
  emitNote(
    [
      "Legacy plugin manifest capability keys detected.",
      ...migrations.flatMap((migration) => migration.changeLines),
    ].join("\n"),
    "Plugin manifests",
  );

  const shouldRepair =
    params.prompter.shouldRepair ||
    (await params.prompter.confirmAutoFix({
      message: "Rewrite legacy plugin manifest capability keys into contracts now?",
      initialValue: true,
    }));
  if (!shouldRepair) {
    return;
  }

  const repaired = await repairLegacyPluginManifestContracts({
    runtime: params.runtime,
    migrations,
    ...(params.config ? { config: params.config } : {}),
    ...(params.env ? { env: params.env } : {}),
    ...(params.manifestRoots ? { manifestRoots: params.manifestRoots } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });

  if (repaired.changes.length > 0) {
    emitNote(repaired.changes.join("\n"), "Doctor changes");
  }
}
