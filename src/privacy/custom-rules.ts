/**
 * Custom privacy rules — loading, validation, and merging of user-defined rules.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSON5 from "json5";
import { compileSafeRegex } from "../security/safe-regex.js";
import { validateBarePassword, validateHighEntropy } from "./detector.js";
import { BASIC_RULES, EXTENDED_RULES } from "./rules.js";
import type { CustomRulesConfig, PrivacyRule, RiskLevel, UserDefinedRule } from "./types.js";

/** Registry of named validator functions that JSON configs can reference. */
const NAMED_VALIDATORS: Record<string, (s: string) => boolean> = {
  bare_password: validateBarePassword,
  high_entropy: validateHighEntropy,
};

/** A single validation error for a user-defined rule. */
export interface RuleValidationError {
  ruleIndex: number;
  type: string;
  field: string;
  message: string;
}

/** Result of loading custom rules. */
export interface CustomRulesResult {
  rules: PrivacyRule[];
  errors: RuleValidationError[];
  warnings: string[];
}

const VALID_RISK_LEVELS: RiskLevel[] = ["low", "medium", "high", "critical"];
const TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_PATTERN_LENGTH = 2000;

/**
 * Load custom rules from a JSON5 file path.
 * Returns merged rules (base preset + custom) and any validation errors.
 */
export function loadCustomRules(filePath: string): CustomRulesResult {
  const absolutePath = resolve(filePath);
  let content: string;
  try {
    content = readFileSync(absolutePath, "utf-8");
  } catch (err) {
    return {
      rules: [...EXTENDED_RULES],
      errors: [],
      warnings: [
        `Failed to read custom rules file "${absolutePath}": ${(err as Error).message}. Falling back to extended rules.`,
      ],
    };
  }

  let config: CustomRulesConfig;
  try {
    config = JSON5.parse(content);
  } catch (err) {
    return {
      rules: [...EXTENDED_RULES],
      errors: [],
      warnings: [
        `Failed to parse custom rules file "${absolutePath}": ${(err as Error).message}. Falling back to extended rules.`,
      ],
    };
  }

  return processCustomRulesConfig(config);
}

/**
 * Process a CustomRulesConfig object (already parsed).
 * Validates rules, resolves base preset, merges, and returns final rule set.
 */
export function processCustomRulesConfig(config: CustomRulesConfig): CustomRulesResult {
  const errors: RuleValidationError[] = [];
  const warnings: string[] = [];

  // 1. Resolve base preset.
  const basePreset = config.extends ?? "extended";
  let baseRules: PrivacyRule[];
  if (basePreset === "none") {
    baseRules = [];
  } else if (basePreset === "basic") {
    baseRules = BASIC_RULES.map((r) => ({ ...r }));
  } else {
    baseRules = EXTENDED_RULES.map((r) => ({ ...r }));
  }

  // 2. Apply disable list.
  const disableSet = new Set(config.disable ?? []);
  if (disableSet.size > 0) {
    baseRules = baseRules.map((r) => (disableSet.has(r.type) ? { ...r, enabled: false } : r));
  }

  // 3. Validate and convert user rules.
  const userRules = config.rules ?? [];
  const validUserRules: PrivacyRule[] = [];
  for (let i = 0; i < userRules.length; i++) {
    const ruleErrors = validateUserRule(userRules[i], i);
    errors.push(...ruleErrors);
    if (ruleErrors.length === 0) {
      validUserRules.push(convertToPrivacyRule(userRules[i]));
    }
  }

  // 4. Merge: user rules override base rules with same type.
  const merged = mergeRules(baseRules, validUserRules);

  return { rules: merged, errors, warnings };
}

/** Validate a single user-defined rule. Returns validation errors (empty = valid). */
export function validateUserRule(rule: UserDefinedRule, index: number): RuleValidationError[] {
  const errors: RuleValidationError[] = [];
  const type = rule.type ?? "";

  if (!type || typeof type !== "string") {
    errors.push({
      ruleIndex: index,
      type,
      field: "type",
      message: "type is required and must be a non-empty string",
    });
  } else if (!TYPE_PATTERN.test(type)) {
    errors.push({
      ruleIndex: index,
      type,
      field: "type",
      message: "type must match [a-z][a-z0-9_]* (lowercase snake_case)",
    });
  }

  if (!rule.description || typeof rule.description !== "string") {
    errors.push({
      ruleIndex: index,
      type,
      field: "description",
      message: "description is required",
    });
  }

  if (!VALID_RISK_LEVELS.includes(rule.riskLevel)) {
    errors.push({
      ruleIndex: index,
      type,
      field: "riskLevel",
      message: `riskLevel must be one of: ${VALID_RISK_LEVELS.join(", ")}`,
    });
  }

  if (!rule.pattern && (!rule.keywords || rule.keywords.length === 0)) {
    errors.push({
      ruleIndex: index,
      type,
      field: "pattern",
      message: "at least one of pattern or keywords is required",
    });
  }

  if (rule.pattern) {
    const regexError = validateRegexSafety(rule.pattern);
    if (regexError) {
      errors.push({ ruleIndex: index, type, field: "pattern", message: regexError });
    }
  }

  if (rule.validateFn && !NAMED_VALIDATORS[rule.validateFn]) {
    errors.push({
      ruleIndex: index,
      type,
      field: "validateFn",
      message: `unknown validator "${rule.validateFn}". Available: ${Object.keys(NAMED_VALIDATORS).join(", ")}`,
    });
  }

  return errors;
}

/**
 * Validate a regex pattern string for safety.
 * Checks: compilability, length limit, nested quantifier heuristic.
 */
export function validateRegexSafety(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`;
  }

  let src = pattern;
  let flags = "gm";
  if (src.startsWith("(?i)")) {
    src = src.slice(4);
    flags += "i";
  }

  try {
    new RegExp(src, flags);
  } catch (err) {
    return `invalid regex: ${(err as Error).message}`;
  }

  // Block known unsafe repetition forms using the shared safe-regex guard.
  if (!compileSafeRegex(src, flags)) {
    return "pattern is potentially unsafe (catastrophic backtracking risk)";
  }

  // Block ambiguous alternation under repetition (e.g. (a|ab)*, (a|a)+).
  if (hasAmbiguousAlternationRepetition(src)) {
    return "pattern has ambiguous alternation under repetition (potential backtracking risk)";
  }

  // Block greedy-dot group repetitions that can explode with trailing overlap.
  if (/\((?:[^()]|\([^)]*\))*\.\*(?:[^()]|\([^)]*\))*\)\s*\{/.test(src)) {
    return "pattern repeats groups containing .* (potential catastrophic backtracking risk)";
  }

  return null;
}

function hasAmbiguousAlternationRepetition(source: string): boolean {
  const repeatedAltGroup = /\(([^()]*\|[^()]*)\)\s*(?:[+*]|\{(?:\d+)(?:,\d*)?\})/g;
  let match: RegExpExecArray | null;

  while ((match = repeatedAltGroup.exec(source)) !== null) {
    const alts = match[1]
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = 0; i < alts.length; i++) {
      for (let j = 0; j < alts.length; j++) {
        if (i === j) {
          continue;
        }
        if (alts[j].startsWith(alts[i])) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Convert a UserDefinedRule to a PrivacyRule. */
function convertToPrivacyRule(userRule: UserDefinedRule): PrivacyRule {
  const rule: PrivacyRule = {
    type: userRule.type,
    description: userRule.description,
    enabled: userRule.enabled !== false,
    riskLevel: userRule.riskLevel,
  };

  if (userRule.pattern) {
    rule.pattern = userRule.pattern;
  }
  if (userRule.keywords) {
    rule.keywords = userRule.keywords;
  }
  if (userRule.caseSensitive !== undefined) {
    rule.caseSensitive = userRule.caseSensitive;
  }
  if (userRule.context) {
    rule.context = userRule.context;
  }
  if (userRule.validateFn) {
    rule.validate = NAMED_VALIDATORS[userRule.validateFn];
  }
  if (userRule.replacementTemplate) {
    rule.replacementTemplate = userRule.replacementTemplate;
  }

  return rule;
}

/**
 * Merge base rules with user rules.
 * User rules with the same `type` override the base rule entirely.
 * New types are appended at the end.
 */
function mergeRules(base: PrivacyRule[], user: PrivacyRule[]): PrivacyRule[] {
  const userTypeMap = new Map(user.map((r) => [r.type, r]));
  const merged: PrivacyRule[] = [];
  const usedUserTypes = new Set<string>();

  for (const baseRule of base) {
    if (userTypeMap.has(baseRule.type)) {
      merged.push(userTypeMap.get(baseRule.type)!);
      usedUserTypes.add(baseRule.type);
    } else {
      merged.push(baseRule);
    }
  }

  for (const userRule of user) {
    if (!usedUserTypes.has(userRule.type)) {
      merged.push(userRule);
    }
  }

  return merged;
}

/**
 * Register a named validator function.
 * Allows plugins/extensions to register custom validators by name.
 */
export function registerNamedValidator(name: string, fn: (matched: string) => boolean): void {
  NAMED_VALIDATORS[name] = fn;
}

/** Get all available named validator names. */
export function getNamedValidators(): string[] {
  return Object.keys(NAMED_VALIDATORS);
}
