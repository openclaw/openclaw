const RECOVERY_STORAGE_PREFIX = "openclaw.new-session.session-placement-recovery.v1:";
// Released readers delete unknown targets and clear their entire v1 scope.
// Required placement must survive returning to those versions in the same tab.
const REQUIRED_RECOVERY_STORAGE_PREFIX = "openclaw.new-session.required-placement-recovery.v1:";

// Web Storage keys are JS strings, so frame UTF-16 code units directly.
// This keeps every component unambiguous without rejecting lone surrogates.
function sessionPlacementRecoveryScopeStoragePrefix(
  gatewayUrl: string,
  recoveryScope: string,
  required = false,
): string {
  const prefix = required ? REQUIRED_RECOVERY_STORAGE_PREFIX : RECOVERY_STORAGE_PREFIX;
  return `${prefix}${gatewayUrl.length}:${gatewayUrl}:${recoveryScope.length}:${recoveryScope}:`;
}

export function sessionPlacementRecoveryExactStorageKey(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
  required = false,
): string {
  return `${sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope, required)}${sessionKey.length}:${sessionKey}`;
}

export function sessionPlacementRecoveryExactStorageKeys(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
): string[] {
  return [true, false].map((required) =>
    sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey, required),
  );
}

// Enumerate scope ownership without loading payload validators into the startup graph.
export function listSessionPlacementRecoveryStorageKeys(
  gatewayUrl: string,
  recoveryScope: string,
): string[] {
  try {
    const storage = globalThis.sessionStorage;
    const prefixes = [false, true].map((required) =>
      sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope, required),
    );
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
        keys.push(key);
      }
    }
    return keys.toSorted();
  } catch {
    return [];
  }
}
