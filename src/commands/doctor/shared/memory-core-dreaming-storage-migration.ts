import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { asObjectRecord } from "./object.js";

// v2026.4.21 changed `plugins.entries.memory-core.config.dreaming.storage`
// from a string ("both" | "inline" | "separate") to an object
// ({ mode, separateReports }). Configs persisted before the upgrade fail
// schema validation on first launch after `npm update`, which then blocks
// the rest of the CLI. See https://github.com/openclaw/openclaw/issues/70407.
//
// This repair runs before `maybeRepairInvalidPluginConfig` so a string-shaped
// `storage` value is normalized to the new object before the generic
// invalid-plugin-config quarantine path can disable the entire memory-core
// plugin and drop the user's other dreaming settings.
const KNOWN_STORAGE_MODES = new Set(["both", "inline", "separate"]);

export function maybeMigrateMemoryCoreDreamingStorage(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entries = asObjectRecord(cfg.plugins?.entries);
  const memoryCore = entries ? asObjectRecord(entries["memory-core"]) : null;
  const memoryCoreConfig = memoryCore ? asObjectRecord(memoryCore.config) : null;
  const dreaming = memoryCoreConfig ? asObjectRecord(memoryCoreConfig.dreaming) : null;
  if (!dreaming) {
    return { config: cfg, changes: [] };
  }
  const storage = dreaming.storage;
  if (typeof storage !== "string" || !KNOWN_STORAGE_MODES.has(storage)) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const nextEntries = asObjectRecord(next.plugins?.entries);
  const nextMemoryCore = nextEntries ? asObjectRecord(nextEntries["memory-core"]) : null;
  const nextConfig = nextMemoryCore ? asObjectRecord(nextMemoryCore.config) : null;
  const nextDreaming = nextConfig ? asObjectRecord(nextConfig.dreaming) : null;
  if (!nextDreaming) {
    // Structural guards above already excluded this path; treat as no-op
    // rather than mutating partial state.
    return { config: cfg, changes: [] };
  }
  nextDreaming.storage = { mode: storage, separateReports: false };

  return {
    config: next,
    changes: [
      sanitizeForLog(
        `- plugins.entries.memory-core.config.dreaming.storage: migrated legacy string "${storage}" to { mode: "${storage}", separateReports: false } (v2026.4.21 schema change, #70407)`,
      ),
    ],
  };
}
