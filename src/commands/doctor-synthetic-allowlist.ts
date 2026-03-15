import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { buildAllowedModelSet, modelKey } from "../agents/model-selection.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

/**
 * The exact provider/id pairs created by `applySyntheticCatalogFallbacks()`.
 * Only these are checked to avoid false positives from real catalog models
 * that happen to share the same provider.
 */
const SYNTHETIC_FALLBACK_KEYS = new Set([
  "openai/gpt-5.4",
  "openai/gpt-5.4-pro",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.3-codex-spark",
]);

/**
 * Warn when synthetic catalog fallback models are present in the runtime
 * catalog but missing from the operator's explicit model allowlist.
 *
 * Skips the check when no allowlist is configured (empty
 * `agents.defaults.models` means all models are allowed).
 *
 * @see https://github.com/openclaw/openclaw/issues/39992
 */
export async function noteSyntheticAllowlistGaps(cfg: OpenClawConfig): Promise<void> {
  const modelsConfig = cfg.agents?.defaults?.models;
  if (!modelsConfig || Object.keys(modelsConfig).length === 0) {
    return;
  }

  const catalog = await loadModelCatalog({ config: cfg });
  const { allowAny, allowedKeys } = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  if (allowAny) {
    return; // all models are allowed; nothing to warn about
  }

  const gaps: Array<{ provider: string; id: string }> = [];
  for (const entry of catalog) {
    const key = modelKey(entry.provider, entry.id);
    if (!SYNTHETIC_FALLBACK_KEYS.has(key)) {
      continue;
    }
    if (!allowedKeys.has(key)) {
      gaps.push(entry);
    }
  }

  if (gaps.length === 0) {
    return;
  }

  const lines = [
    `${gaps.length} synthetic model${gaps.length === 1 ? "" : "s"} available but not in your allowlist:`,
  ];
  for (const entry of gaps) {
    lines.push(`  - ${modelKey(entry.provider, entry.id)}`);
  }
  lines.push(
    `To add: ${formatCliCommand("openclaw models allowlist add <model-id>")}`,
    "(Models are functional but hidden from agents until allowlisted)",
  );
  note(lines.join("\n"), "Synthetic model allowlist");
}
