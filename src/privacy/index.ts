/**
 * Privacy filter module — detects and replaces sensitive information
 * in messages before sending to LLM APIs.
 */

export { PrivacyDetector } from "./detector.js";
export { PrivacyReplacer } from "./replacer.js";
export { PrivacyMappingStore } from "./mapping-store.js";
export {
  createPrivacyFilterContext,
  filterText,
  restoreText,
  filterMessages,
  filterPrompt,
  restoreResponse,
  wrapStreamFnPrivacyFilter,
} from "./stream-wrapper.js";
export type { PrivacyFilterContext } from "./stream-wrapper.js";
export { BASIC_RULES, EXTENDED_RULES, resolveRules } from "./rules.js";
export {
  loadCustomRules,
  processCustomRulesConfig,
  registerNamedValidator,
  getNamedValidators,
  validateUserRule,
  validateRegexSafety,
} from "./custom-rules.js";
export type { RuleValidationError, CustomRulesResult } from "./custom-rules.js";
export type {
  CustomRulesConfig,
  DetectionMatch,
  FilterResult,
  PrivacyConfig,
  PrivacyContext,
  PrivacyMapping,
  PrivacyRule,
  RiskLevel,
  RuleContext,
  UserDefinedRule,
} from "./types.js";
export { DEFAULT_PRIVACY_CONFIG } from "./types.js";
