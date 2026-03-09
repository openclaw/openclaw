/**
 * Settings panel logic: command response builder, callback handler, config mutation.
 *
 * The panel lets Telegram users configure account-level settings via inline
 * keyboard buttons instead of memorizing /config set paths.
 */

import { setConfigValueAtPath } from "../config/config-paths.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  readConfigFileSnapshotForWrite,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { ButtonRow } from "./model-buttons.js";
import {
  type ParsedSettingsCallback,
  type SettingKey,
  buildAllowlistView,
  buildSettingSubmenu,
  buildSettingsMainMenu,
  normalizeStreamingDisplay,
} from "./settings-buttons.js";

/** Config path segments for each setting key, per account scope. */
function resolveConfigPath(accountId: string, setting: SettingKey): string[] {
  const normalized = normalizeAccountId(accountId);
  const settingToConfigKey: Record<SettingKey, string> = {
    dmpol: "dmPolicy",
    grppol: "groupPolicy",
    stream: "streaming",
  };
  const configKey = settingToConfigKey[setting];

  if (normalized === "default") {
    return ["channels", "telegram", configKey];
  }
  return ["channels", "telegram", "accounts", normalized, configKey];
}

/** Read the effective value of a setting from the Telegram account config. */
function readCurrentValue(
  telegramCfg: TelegramAccountConfig,
  setting: SettingKey,
): string | undefined {
  switch (setting) {
    case "dmpol":
      return telegramCfg.dmPolicy;
    case "grppol":
      return telegramCfg.groupPolicy;
    case "stream":
      return normalizeStreamingDisplay(telegramCfg.streaming);
  }
}

export type BuildSettingsCommandResponseResult = {
  text: string;
  buttons: ButtonRow[];
};

/**
 * Build the initial /settings command response (main menu).
 */
export function buildSettingsCommandResponse(
  telegramCfg: TelegramAccountConfig,
): BuildSettingsCommandResponseResult {
  return buildSettingsMainMenu({
    dmPolicy: telegramCfg.dmPolicy,
    groupPolicy: telegramCfg.groupPolicy,
    streaming: normalizeStreamingDisplay(telegramCfg.streaming),
  });
}

export type HandleSettingsCallbackParams = {
  parsed: ParsedSettingsCallback;
  cfg: OpenClawConfig;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  editMessage: (text: string, buttons: ButtonRow[]) => Promise<void>;
  answerCallback: (text: string) => Promise<void>;
};

/**
 * Handle a settings callback button press.
 *
 * - menu: re-render main menu with current values
 * - submenu: show setting options with checkmark on current value
 * - set: apply the config change, re-render submenu with updated checkmark
 */
export async function handleSettingsCallback(params: HandleSettingsCallbackParams): Promise<void> {
  const { parsed, telegramCfg, accountId, editMessage, answerCallback } = params;

  if (parsed.type === "menu") {
    const { text, buttons } = buildSettingsCommandResponse(telegramCfg);
    await editMessage(text, buttons);
    return;
  }

  if (parsed.type === "submenu") {
    if (parsed.setting === "allow") {
      // Allowlist is a read-only submenu — shows current entries
      const dmEntries = (telegramCfg.allowFrom ?? []).map(String);
      const groupEntries = (telegramCfg.groupAllowFrom ?? []).map(String);
      const { text, buttons } = buildAllowlistView(dmEntries, groupEntries);
      await editMessage(text, buttons);
      return;
    }
    const current = readCurrentValue(telegramCfg, parsed.setting);
    const { text, buttons } = buildSettingSubmenu(parsed.setting, current);
    await editMessage(text, buttons);
    return;
  }

  if (parsed.type === "set") {
    const current = readCurrentValue(telegramCfg, parsed.setting);
    if (current === parsed.value) {
      // Value already set — no-op. Checkmark is already visible.
      return;
    }

    const result = await applySettingChange(accountId, parsed.setting, parsed.value);
    if (!result.ok) {
      // Show error inline in the submenu + send a chat message for visibility
      await answerCallback(`Failed: ${result.error}`);
      const { text, buttons } = buildSettingSubmenu(parsed.setting, current);
      await editMessage(`\u274c ${result.error}\n\n${text}`, buttons);
      return;
    }

    // Re-render submenu showing updated checkmark (visual confirmation)
    const { text, buttons } = buildSettingSubmenu(parsed.setting, parsed.value);
    await editMessage(text, buttons);
  }
}

type ApplyResult = { ok: true } | { ok: false; error: string };

/**
 * Apply a setting change to the config file using the async snapshot pipeline:
 * readConfigFileSnapshotForWrite → clone resolved → mutate → validate → write.
 */
async function applySettingChange(
  accountId: string,
  setting: SettingKey,
  value: string,
): Promise<ApplyResult> {
  try {
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!snapshot.valid) {
      return { ok: false, error: "Config file has validation errors" };
    }

    const configClone = structuredClone(snapshot.resolved) as Record<string, unknown>;
    const path = resolveConfigPath(accountId, setting);
    setConfigValueAtPath(configClone, path, value);

    const validated = validateConfigObjectWithPlugins(configClone);
    if (!validated.ok) {
      const firstIssue = validated.issues[0]?.message ?? "Validation failed";
      return { ok: false, error: firstIssue };
    }

    await writeConfigFile(validated.config, writeOptions);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Export for testing
export { applySettingChange as _applySettingChange, resolveConfigPath as _resolveConfigPath };
