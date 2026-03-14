/**
 * Custom privacy rules — loading, validation, and merging of user-defined rules.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import { resolveConfigPath } from "../config/paths.js";
import { compileSafeRegex } from "../security/safe-regex.js";
import { validateBarePassword, validateHighEntropy } from "./detector.js";
import { BASIC_RULES, EXTENDED_RULES } from "./rules.js";
import type { PrivacyRule, RiskLevel, UserDefinedRule } from "./types.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Resolve custom rules path.
 * Relative paths are interpreted from the active config file directory.
 */
export function resolveCustomRulesPath(filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath;
  }
  const configDir = dirname(resolveConfigPath());
  return resolve(configDir, filePath);
}

/**
 * Load custom rules from a JSON5 file path.
 * Returns merged rules (base preset + custom) and any validation errors.
 */
export function loadCustomRules(filePath: string): CustomRulesResult {
  const absolutePath = resolveCustomRulesPath(filePath);
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

  let parsed: unknown;
  try {
    parsed = JSON5.parse(content);
  } catch (err) {
    return {
      rules: [...EXTENDED_RULES],
      errors: [],
      warnings: [
        `Failed to parse custom rules file "${absolutePath}": ${(err as Error).message}. Falling back to extended rules.`,
      ],
    };
  }

  if (!isRecord(parsed)) {
    return {
      rules: [...EXTENDED_RULES],
      errors: [],
      warnings: [
        `Custom rules file "${absolutePath}" must parse to an object. Falling back to extended rules.`,
      ],
    };
  }

  return processCustomRulesConfig(parsed);
}

/**
 * Process a CustomRulesConfig object (already parsed).
 * Validates rules, resolves base preset, merges, and returns final rule set.
 */
export function processCustomRulesConfig(config: unknown): CustomRulesResult {
  const errors: RuleValidationError[] = [];
  const warnings: string[] = [];
  const rawConfig: Record<string, unknown> = isRecord(config) ? config : {};

  // 1. Resolve base preset.
  const basePresetRaw = rawConfig.extends;
  const basePreset =
    basePresetRaw === "none" || basePresetRaw === "basic" || basePresetRaw === "extended"
      ? basePresetRaw
      : "extended";
  let baseRules: PrivacyRule[];
  if (basePreset === "none") {
    baseRules = [];
  } else if (basePreset === "basic") {
    baseRules = BASIC_RULES.map((r) => ({ ...r }));
  } else {
    baseRules = EXTENDED_RULES.map((r) => ({ ...r }));
  }

  // 2. Apply disable list.
  const disableEntries = Array.isArray(rawConfig.disable) ? rawConfig.disable : [];
  if (rawConfig.disable !== undefined && !Array.isArray(rawConfig.disable)) {
    warnings.push("custom privacy rules: disable must be an array of rule type strings; ignoring.");
  }
  const disableSet = new Set(disableEntries);
  if (disableSet.size > 0) {
    baseRules = baseRules.map((r) => (disableSet.has(r.type) ? { ...r, enabled: false } : r));
  }

  // 3. Validate and convert user rules.
  const rawRules = rawConfig.rules;
  const userRules = Array.isArray(rawRules) ? rawRules : [];
  if (rawRules !== undefined && !Array.isArray(rawRules)) {
    warnings.push("custom privacy rules: rules must be an array; ignoring.");
  }
  const validUserRules: PrivacyRule[] = [];
  for (let i = 0; i < userRules.length; i++) {
    if (!isRecord(userRules[i])) {
      errors.push({
        ruleIndex: i,
        type: "",
        field: "rules",
        message: "rule must be an object",
      });
      continue;
    }
    const ruleErrors = validateUserRule(userRules[i] as UserDefinedRule, i);
    errors.push(...ruleErrors);
    if (ruleErrors.length === 0) {
      validUserRules.push(convertToPrivacyRule(userRules[i] as UserDefinedRule));
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
  const keywords = rule.keywords;
  const hasKeywordsField = keywords !== undefined;
  const keywordsIsArray = Array.isArray(keywords);

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

  if (hasKeywordsField && !keywordsIsArray) {
    errors.push({
      ruleIndex: index,
      type,
      field: "keywords",
      message: "keywords must be an array of strings",
    });
  }

  if (!rule.pattern && (!keywordsIsArray || keywords.length === 0)) {
    errors.push({
      ruleIndex: index,
      type,
      field: "pattern",
      message: "at least one of pattern or keywords is required",
    });
  }

  // Validate that every keyword entry is a string. Non-string values (e.g. numbers
  // from malformed JSON5) would later cause escapeRegex to throw inside
  // PrivacyDetector.loadRules, crashing session startup.
  if (keywordsIsArray) {
    const badIdx = keywords.findIndex((kw) => typeof kw !== "string");
    if (badIdx !== -1) {
      errors.push({
        ruleIndex: index,
        type,
        field: "keywords",
        message: `keywords[${badIdx}] must be a string (got ${typeof keywords[badIdx]})`,
      });
    }
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

  if (rule.context) {
    const { mustContain, mustNotContain } = rule.context;
    if (mustContain !== undefined && !Array.isArray(mustContain)) {
      errors.push({
        ruleIndex: index,
        type,
        field: "context.mustContain",
        message: "context.mustContain must be an array of strings",
      });
    } else if (Array.isArray(mustContain)) {
      const badIdx = mustContain.findIndex((kw) => typeof kw !== "string");
      if (badIdx !== -1) {
        errors.push({
          ruleIndex: index,
          type,
          field: "context.mustContain",
          message: `context.mustContain[${badIdx}] must be a string (got ${typeof mustContain[badIdx]})`,
        });
      }
    }

    if (mustNotContain !== undefined && !Array.isArray(mustNotContain)) {
      errors.push({
        ruleIndex: index,
        type,
        field: "context.mustNotContain",
        message: "context.mustNotContain must be an array of strings",
      });
    } else if (Array.isArray(mustNotContain)) {
      const badIdx = mustNotContain.findIndex((kw) => typeof kw !== "string");
      if (badIdx !== -1) {
        errors.push({
          ruleIndex: index,
          type,
          field: "context.mustNotContain",
          message: `context.mustNotContain[${badIdx}] must be a string (got ${typeof mustNotContain[badIdx]})`,
        });
      }
    }
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

  if (!compileSafeRegex(src, flags)) {
    return "pattern failed safe-regex validation and may cause catastrophic backtracking";
  }

  return null;
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
  if (Array.isArray(userRule.keywords)) {
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
