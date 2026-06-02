import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export type CustomCommandInput = {
  /** User-provided command name, with or without the channel prefix. */
  command?: string | null;
  /** User-facing command description shown by the owning channel. */
  description?: string | null;
};

export type CustomCommandIssue = {
  /** Original command array position for schema/error path reporting. */
  index: number;
  /** Field that owns the validation issue at the original array position. */
  field: "command" | "description";
  /** Complete user-facing validation message with channel-specific wording. */
  message: string;
};

export type CustomCommandConfig = {
  /** Channel or integration name used in validation messages. */
  label: string;
  /** Normalized command-name contract enforced after slash and case cleanup. */
  pattern: RegExp;
  /** Human-readable pattern rule appended to invalid-name messages. */
  patternDescription: string;
  /** Display prefix used in validation messages. Defaults to slash commands. */
  prefix?: string;
};

const DEFAULT_PREFIX = "/";

/** Normalizes slash-style custom command names for validation and storage. */
export function normalizeSlashCommandName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutSlash = trimmed.startsWith(DEFAULT_PREFIX) ? trimmed.slice(1) : trimmed;
  return normalizeLowercaseStringOrEmpty(withoutSlash).replace(/-/g, "_");
}

/** Normalizes a custom command description without changing user text content. */
export function normalizeCommandDescription(value: string): string {
  return value.trim();
}

/**
 * Validates custom command entries and returns only normalized accepted commands.
 */
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
      // Only accepted commands enter the duplicate set; invalid earlier entries
      // do not block fixes later in the list.
      seen.add(normalized);
    }
    resolved.push({ command: normalized, description });
  }

  return { commands: resolved, issues };
}
