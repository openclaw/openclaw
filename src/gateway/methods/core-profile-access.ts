import { isSessionProfileDependentMethod } from "../session-method-policy.js";

const PROFILE_DEPENDENT_CORE_PREFIXES = [
  "artifacts.",
  "chat.",
  "conversations.",
  "controlUi.session",
  "mcp.app.",
  "mentions.",
  "openclaw.approval.",
  "openclaw.chat",
  "progressCard.",
  "projects.",
  "secrets.",
  "session.",
  "sessions.",
  "taskSuggestions.",
  "terminal.",
  "transcripts.",
  "users.authConnect.",
  "users.prefs.",
  "users.background.",
  "themes.",
  "users.github.",
  "skills.library.",
] as const;

/** Classifies session methods and core method families that depend on profile ownership. */
export function isCoreGatewayMethodFamilyProfileDependent(method: string): boolean {
  return (
    isSessionProfileDependentMethod(method) ||
    PROFILE_DEPENDENT_CORE_PREFIXES.some((prefix) => method.startsWith(prefix))
  );
}
