import { asNullableRecord as getRecord } from "@openclaw/normalization-core/record-coerce";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import { readObjectPath } from "../shared/dot-path.js";
import type { LegacyConfigIssue } from "./types.js";

export { ensureRecord } from "@openclaw/normalization-core/record-coerce";
export { getRecord };
export type LegacyConfigRule = {
  path: string[];
  message: string;
  match?: (value: unknown, root: Record<string, unknown>) => boolean;
  // If true, only report when the legacy value is present in the original parsed
  // source (not only after include/env resolution).
  requireSourceLiteral?: boolean;
};

/** Evaluate exactly the rules selected by the migration owner. */
export function findLegacyConfigRuleIssues(
  raw: unknown,
  rules: readonly LegacyConfigRule[],
  sourceRaw?: unknown,
): LegacyConfigIssue[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  // SAFETY: the guard accepts any non-null object, including legacy array inputs.
  const root = raw as Record<string, unknown>;
  const sourceRoot =
    // SAFETY: the same object check preserves source-literal reads without excluding arrays.
    sourceRaw && typeof sourceRaw === "object" ? (sourceRaw as Record<string, unknown>) : root;
  const issues: LegacyConfigIssue[] = [];
  for (const rule of rules) {
    const cursor = readObjectPath(root, rule.path);
    if (cursor !== undefined && (!rule.match || rule.match(cursor, root))) {
      if (rule.requireSourceLiteral) {
        const sourceCursor = readObjectPath(sourceRoot, rule.path);
        if (sourceCursor === undefined) {
          continue;
        }
        if (rule.match && !rule.match(sourceCursor, sourceRoot)) {
          continue;
        }
      }
      issues.push({ path: rule.path.join("."), message: rule.message });
    }
  }
  return issues;
}

export const createLegacyConfigRule = (
  path: string[],
  message: string,
  match?: LegacyConfigRule["match"],
): LegacyConfigRule => ({
  path,
  message: `${message} Run "openclaw doctor --fix".`,
  ...(match ? { match } : {}),
});

export type LegacyConfigMigrationContext = {
  /** Parsed configuration exactly as authored in the root config file. */
  authoredRaw: unknown;
  /** Configuration after include and environment resolution. */
  resolvedRaw: unknown;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

export type LegacyConfigMigrationSpec = {
  id: string;
  legacyRules?: LegacyConfigRule[];
  apply: (
    raw: Record<string, unknown>,
    changes: string[],
    context?: LegacyConfigMigrationContext,
  ) => void;
};

export const mapLegacyAudioTranscription = (value: unknown): Record<string, unknown> | null => {
  const transcriber = getRecord(value);
  const command = Array.isArray(transcriber?.command) ? transcriber?.command : null;
  if (!command || command.length === 0) {
    return null;
  }
  if (typeof command[0] !== "string") {
    return null;
  }
  if (!command.every((part) => typeof part === "string")) {
    return null;
  }
  const rawExecutable = command[0].trim();
  if (!isSafeExecutableValue(rawExecutable)) {
    return null;
  }

  const args = command.slice(1).map((part) => part.replace(/\{input\}/g, "{{AttachmentPath}}"));
  const timeoutSeconds =
    typeof transcriber?.timeoutSeconds === "number" ? transcriber?.timeoutSeconds : undefined;

  const result: Record<string, unknown> = { command: rawExecutable, type: "cli" };
  if (args.length > 0) {
    result.args = args;
  }
  if (timeoutSeconds !== undefined) {
    result.timeoutSeconds = timeoutSeconds;
  }
  return result;
};
