import { randomBytes } from "node:crypto";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionAccess } from "../config/sessions/session-access.js";
import {
  resolveSessionPublicShare,
  type SessionPublicShareGrant,
} from "../config/sessions/session-public-share.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";

/** Call only inside the owning, authorized session mutation's commit preparation. */
export function prepareSessionPublicShareGrant(
  entry: SessionEntry,
  sessionKey: string,
): SessionPublicShareGrant {
  if (entry.incognito || isIncognitoSessionKey(sessionKey)) {
    throw new Error("Incognito sessions cannot be published.");
  }
  const access = resolveSessionAccess(getRuntimeConfig(), sessionKey, entry);
  if (access && access.mode !== "unrestricted") {
    throw new Error("Confidential sessions cannot be published; explicitly change access first.");
  }
  const grant = resolveSessionPublicShare(entry) ?? {
    id: randomBytes(24).toString("hex"),
    sessionId: entry.sessionId,
    createdAt: Date.now(),
  };
  registerSecretValueForRedaction(grant.id);
  return grant;
}
