import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Raw custom command entry accepted from config or legacy SDK callers. */
export type CustomCommandInput = {
  command?: string | null;
  description?: string | null;
};

/** Indexed validation issue that callers can map back onto their config path. */
export type CustomCommandIssue = {
  index: number;
  field: "command" | "description";
  message: string;
};

/** Channel-specific command validation policy shared by config schemas and SDK shims. */
export type CustomCommandConfig = {
  label: string;
  pattern: RegExp;
  patternDescription: string;
  prefix?: string;
};

const DEFAULT_PREFIX = "/";

/** Normalize slash command names before validation and storage. */
export function normalizeSlashCommandName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutSlash = trimmed.startsWith(DEFAULT_PREFIX) ? trimmed.slice(1) : trimmed;
  return normalizeLowercaseStringOrEmpty(withoutSlash).replace(/-/g, "_");
}

/** Normalize command descriptions without applying channel-specific length or content policy. */
export function normalizeCommandDescription(value: string): string {
  return value.trim();
}

/** Resolve valid custom commands and collect validation issues without throwing. */
export function resolveCustomCommands(params: {
  commands?: CustomCommandInput[] | null;
  reservedCommands?: Set<string>;
  checkReserved?: boolean;
  checkDuplicates?: boolean;
  config: CustomCommandConfig;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: CustomCommandIssue[];
} {
  const entries = Array.isArray(params.commands) ? params.commands : [];
  const reserved = params.reservedCommands ?? new Set<string>();
  const checkReserved = params.checkReserved !== false;
  const checkDuplicates = params.checkDuplicates !== false;
  const seen = new Set<string>();
  const resolved: Array<{ command: string; description: string }> = [];
  const issues: CustomCommandIssue[] = [];
  const label = params.config.label;
  const prefix = params.config.prefix ?? DEFAULT_PREFIX;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const normalized = normalizeSlashCommandName(entry?.command ?? "");
    if (!normalized) {
      issues.push({
        index,
        field: "command",
        message: `${label} custom command is missing a command name.`,
      });
      continue;
    }
    if (!params.config.pattern.test(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `${label} custom command "${prefix}${normalized}" is invalid (${params.config.patternDescription}).`,
      });
      continue;
    }
    if (checkReserved && reserved.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `${label} custom command "${prefix}${normalized}" conflicts with a native command.`,
      });
      continue;
    }
    if (checkDuplicates && seen.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `${label} custom command "${prefix}${normalized}" is duplicated.`,
      });
      continue;
    }
    const description = normalizeCommandDescription(entry?.description ?? "");
    if (!description) {
      issues.push({
        index,
        field: "description",
        message: `${label} custom command "${prefix}${normalized}" is missing a description.`,
      });
      continue;
    }
    if (checkDuplicates) {
      // Only accepted commands enter duplicate tracking so invalid earlier
      // entries do not block a later valid definition for the same name.
      seen.add(normalized);
    }
    resolved.push({ command: normalized, description });
  }

  return { commands: resolved, issues };
}
