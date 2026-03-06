import type { SlackSlashCommandConfig } from "../../config/config.js";

export type ResolvedSlackSlashCommandConfig = Omit<
  Required<SlackSlashCommandConfig>,
  "nativePrefix" | "nativeNames"
> & {
  nativePrefix?: string;
  nativeNames?: Record<string, string>;
};

/**
 * Strip Slack mentions (<@U123>, <@U123|name>) so command detection works on
 * normalized text. Use in both prepare and debounce gate for consistency.
 */
export function stripSlackMentionsForCommandDetection(text: string): string {
  return (text ?? "")
    .replace(/<@[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSlackSlashCommandName(raw: string) {
  return raw.replace(/^\/+/, "");
}

export function resolveSlackSlashCommandConfig(
  raw?: SlackSlashCommandConfig,
): ResolvedSlackSlashCommandConfig {
  const normalizedName = normalizeSlackSlashCommandName(raw?.name?.trim() || "openclaw");
  const name = normalizedName || "openclaw";
  const nativePrefix = raw?.nativePrefix?.trim();
  return {
    enabled: raw?.enabled === true,
    name,
    nativePrefix: nativePrefix || undefined,
    nativeNames: raw?.nativeNames,
    sessionPrefix: raw?.sessionPrefix?.trim() || "slack:slash",
    ephemeral: raw?.ephemeral !== false,
  };
}

export function buildSlackSlashCommandMatcher(name: string) {
  const normalized = normalizeSlackSlashCommandName(name);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^/?${escaped}$`);
}
