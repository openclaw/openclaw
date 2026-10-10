import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import { CONFIG_BACKUP_COUNT } from "../../../config/backup-rotation.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { containsAuthoredInclude, readDoctorConfigBackup } from "./include-migration-ownership.js";
import { applyProviderRenames, planProviderRenames } from "./provider-rename.js";
import type { ProviderRename } from "./provider-rename.js";

/** Recover a lost post-write plan only while the recorded provider topology still matches. */
export function resolveDoctorProviderRenames(params: {
  config: OpenClawConfig;
  snapshot: Pick<ConfigFileSnapshot, "path" | "parsed" | "authoredConfig">;
  declarations: readonly ProviderRename[];
}): { renames: ProviderRename[]; warnings: string[] } {
  const renames = planProviderRenames(params.config, params.declarations);
  if (renames.length > 0 || params.declarations.length === 0) {
    return { renames, warnings: [] };
  }
  const authored = params.snapshot.authoredConfig ?? params.snapshot.parsed;
  if (!isRecord(authored) || containsAuthoredInclude(authored)) {
    return { renames: [], warnings: [] };
  }
  const models = authored.models;
  for (let index = 0; index < CONFIG_BACKUP_COUNT; index++) {
    const backupPath = `${params.snapshot.path}.bak${index === 0 ? "" : `.${index}`}`;
    let backup: unknown;
    try {
      const raw = readDoctorConfigBackup(backupPath);
      if (raw === undefined) {
        continue;
      }
      backup = JSON5.parse(raw);
    } catch {
      return {
        renames: [],
        warnings: [
          `Could not inspect ${backupPath} for provider model-reference migration recovery.`,
        ],
      };
    }
    if (!isRecord(backup) || containsAuthoredInclude(backup)) {
      break;
    }
    if (isDeepStrictEqual(backup.models, models)) {
      continue;
    }
    const historical = backup as OpenClawConfig;
    const pending = planProviderRenames(historical, params.declarations);
    if (
      pending.length > 0 &&
      isDeepStrictEqual(applyProviderRenames(historical, pending).config.models, models)
    ) {
      return { renames: pending, warnings: [] };
    }
    // Do not search through an intervening provider edit or reinterpret historical includes.
    break;
  }
  return { renames: [], warnings: [] };
}
