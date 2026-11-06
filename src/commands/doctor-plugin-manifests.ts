import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { z } from "zod";
import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { safeParseJsonWithSchema, safeParseWithSchema } from "../utils/zod-parse.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const LEGACY_MANIFEST_CONTRACT_KEYS = [
  "speechProviders",
  "mediaUnderstandingProviders",
  "imageGenerationProviders",
  "tools",
] as const;
const LEGACY_PLUGIN_MANIFESTS_CHECK_ID = "core/doctor/legacy-plugin-manifests";

type LegacyManifestContractMigration = NonNullable<
  ReturnType<typeof buildLegacyManifestContractMigration>
>;

const JsonRecordSchema = z.record(z.string(), z.unknown());

function manifestSeenKey(manifestPath: string): string {
  try {
    return fs.realpathSync.native(manifestPath);
  } catch {
    return path.resolve(manifestPath);
  }
}

function buildLegacyManifestContractMigration(params: {
  manifestPath: string;
  raw: Record<string, unknown>;
}) {
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

export function collectLegacyPluginManifestContractMigrations(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  runtime?: Pick<RuntimeEnv, "error">;
}): LegacyManifestContractMigration[] {
  const seen = new Set<string>();
  const migrations: LegacyManifestContractMigration[] = [];
  for (const { manifestPath } of loadPluginManifestRegistryCore(params).plugins) {
    const seenKey = manifestSeenKey(manifestPath);
    if (seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);
    let raw: Record<string, unknown> | null;
    try {
      const bytes = fs.readFileSync(manifestPath);
      if (!isUtf8(bytes)) {
        params.runtime?.error("Invalid UTF-8; plugin manifest left unchanged:", manifestPath);
        continue;
      }
      raw = safeParseJsonWithSchema(JsonRecordSchema, bytes.toString("utf-8"));
    } catch {
      continue;
    }
    const migration = raw && buildLegacyManifestContractMigration({ manifestPath, raw });
    if (migration) {
      migrations.push(migration);
    }
  }

  return migrations.toSorted((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

export function legacyPluginManifestContractMigrationToHealthFinding(
  migration: LegacyManifestContractMigration,
): HealthFinding {
  return {
    checkId: LEGACY_PLUGIN_MANIFESTS_CHECK_ID,
    severity: "warning",
    category: "fix-now",
    docsUrl: "https://docs.openclaw.ai/cli/doctor/checks",
    message: `Plugin manifest ${migration.pluginId} uses legacy top-level capability keys.`,
    path: migration.manifestPath,
    target: migration.pluginId,
    requirement: "contracts-capability-keys",
    fixHint:
      "Run `openclaw doctor --fix` to rewrite legacy plugin manifest capability keys under contracts.*.",
  };
}

export async function maybeRepairLegacyPluginManifestContracts(
  params: NonNullable<Parameters<typeof collectLegacyPluginManifestContractMigrations>[0]> & {
    runtime: RuntimeEnv;
    prompter: DoctorPrompter;
  },
): Promise<boolean> {
  const migrations = collectLegacyPluginManifestContractMigrations(params);
  if (migrations.length === 0) {
    return false;
  }

  note(
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
    return false;
  }

  const applied: string[] = [];
  for (const migration of migrations) {
    try {
      fs.writeFileSync(
        migration.manifestPath,
        `${JSON.stringify(migration.nextRaw, null, 2)}\n`,
        "utf-8",
      );
      applied.push(...migration.changeLines);
    } catch (error) {
      params.runtime.error(
        `Failed to rewrite legacy plugin manifest at ${migration.manifestPath}: ${String(error)}`,
      );
    }
  }

  if (applied.length > 0) {
    note(applied.join("\n"), "Doctor changes");
  }
  return applied.length > 0;
}
