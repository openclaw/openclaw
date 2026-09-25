import {
  identityHasStableSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";

export function isResumableOneShotAcpSession(acpEntry: AcpSessionStoreEntry): boolean {
  const identity = resolveSessionIdentityFromMeta(acpEntry.acp);
  return (
    acpEntry.acp?.mode === "oneshot" &&
    identity?.sessionResumeSupported === true &&
    identity.sessionResumeReady === true &&
    identityHasStableSessionId(identity)
  );
}
