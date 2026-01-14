import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  migrateLegacyConfig,
  readConfigFileSnapshot,
} from "../config/config.js";
import { note } from "../terminal/note.js";
import { normalizeLegacyConfigValues } from "./doctor-legacy-config.js";
import type { DoctorOptions } from "./doctor-prompter.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function noteOpencodeProviderOverrides(cfg: ClawdbotConfig) {
  const providers = cfg.models?.providers;
  if (!providers) return;

  // 2026-01-10: warn when OpenCode Zen overrides mask built-in routing/costs (8a194b4abc360c6098f157956bb9322576b44d51, 2d105d16f8a099276114173836d46b46cdfbdbae).
  const overrides: string[] = [];
  if (providers.opencode) overrides.push("opencode");
  if (providers["opencode-zen"]) overrides.push("opencode-zen");
  if (overrides.length === 0) return;

  const lines = overrides.flatMap((id) => {
    const providerEntry = providers[id];
    const api =
      isRecord(providerEntry) && typeof providerEntry.api === "string"
        ? providerEntry.api
        : undefined;
    return [
      `- models.providers.${id} is set; this overrides the built-in OpenCode Zen catalog.`,
      api ? `- models.providers.${id}.api=${api}` : null,
    ].filter((line): line is string => Boolean(line));
  });

  lines.push(
    "- Remove these entries to restore per-model API routing + costs (then re-run onboarding if needed).",
  );

  note(lines.join("\n"), "OpenCode Zen");
}

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}) {
  const snapshot = await readConfigFileSnapshot();
  let cfg: ClawdbotConfig = snapshot.valid ? snapshot.config : {};
  if (snapshot.exists && !snapshot.valid && snapshot.legacyIssues.length === 0) {
    note("Config invalid; doctor will run with defaults.", "Config");
  }

  if (snapshot.legacyIssues.length > 0) {
    note(
      snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"),
      "Legacy config keys detected",
    );
    const migrate =
      params.options.nonInteractive === true
        ? true
        : await params.confirm({
            message: "Migrate legacy config entries now?",
            initialValue: true,
          });
    if (migrate) {
      // Legacy migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into channels.whatsapp.allowFrom.
      const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
      if (changes.length > 0) note(changes.join("\n"), "Doctor changes");
      if (migrated) cfg = migrated;
    }
  }

  const normalized = normalizeLegacyConfigValues(cfg);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    cfg = normalized.config;
  }

  noteOpencodeProviderOverrides(cfg);

  return { cfg, path: snapshot.path ?? CONFIG_PATH_CLAWDBOT };
}
