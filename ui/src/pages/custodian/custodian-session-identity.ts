import { generateUUID } from "../../lib/uuid.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const CUSTODIAN_SESSION_STORAGE_KEY = "openclaw.custodian.session.v1";

export function createCustodianSessionId(): string {
  return `control-ui-onboarding-${generateUUID()}`;
}

export function persistCustodianSessionId(sessionId: string): void {
  try {
    getSafeLocalStorage()?.setItem(CUSTODIAN_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Storage can be blocked independently of the rest of the Control UI.
  }
}

/** Restore the persisted companion session id, or mint and persist a fresh one. */
export function loadCustodianSessionId(): string {
  let stored: string | null = null;
  try {
    stored = getSafeLocalStorage()?.getItem(CUSTODIAN_SESSION_STORAGE_KEY) ?? null;
  } catch {
    // Fall through to a process-local id when storage is unavailable.
  }
  if (stored !== null && stored.length <= 512 && stored.trim().length > 0) {
    return stored;
  }
  const sessionId = createCustodianSessionId();
  persistCustodianSessionId(sessionId);
  return sessionId;
}
