// Redacts credential-bearing command arguments while preserving argv shape.
import { redactToolPayloadText } from "../logging/redact.js";

// These credential flags do not have a sensitive suffix.
const SECRET_FLAG_NAMES = new Set(["--provider-env", "--active-key"]);

const SECRET_FLAG_SUFFIX_PATTERN =
  /^--(?:[a-z0-9]+(?:[-_][a-z0-9]+)*[-_])?(?:token|secret|password|passwd|passphrase|pin|api[-_]?key|api[-_]?secret|secret[-_]?key|secret[-_]?access[-_]?key|access[-_]?key(?:[-_]?id)?|account[-_]?key|client[-_]?key|consumer[-_]?key|license[-_]?key|subscription[-_]?key|webhook|credentials?|creds?|auth(?:orization)?|bearer|pat|cookie|private[-_]?key|recovery[-_]?key|signing[-_]?key|encryption[-_]?key|master[-_]?key|session[-_]?key|gateway[-_]?key|service[-_]?key|hook[-_]?key)$/;

function parseFlagName(arg: string): string | null {
  if (!arg.startsWith("--")) {
    return null;
  }
  const equalsIndex = arg.indexOf("=");
  return (equalsIndex === -1 ? arg : arg.slice(0, equalsIndex)).toLowerCase();
}

function isSecretFlagName(flagName: string): boolean {
  return SECRET_FLAG_NAMES.has(flagName) || SECRET_FLAG_SUFFIX_PATTERN.test(flagName);
}

/**
 * Redacts recognized argv secrets without changing array length or non-secret flags.
 * Known secret flags bind the next value even when it begins with a dash; other
 * elements use the shared deterministic secret-text patterns.
 */
export function redactSensitiveArgv(argv: readonly string[], redactedValue?: string): string[] {
  const replacement = redactedValue ?? "***";
  const result: string[] = [];
  let redactNext = false;
  for (const current of argv) {
    if (redactNext) {
      redactNext = false;
      result.push(replacement);
      continue;
    }
    const currentFlag = parseFlagName(current);
    if (currentFlag !== null && isSecretFlagName(currentFlag)) {
      const equalsIndex = current.indexOf("=");
      if (equalsIndex !== -1) {
        result.push(`${current.slice(0, equalsIndex + 1)}${replacement}`);
        continue;
      }
      result.push(current);
      redactNext = true;
      continue;
    }
    const redacted = redactToolPayloadText(current);
    result.push(redacted === current ? current : (redactedValue ?? redacted));
  }
  return result;
}
