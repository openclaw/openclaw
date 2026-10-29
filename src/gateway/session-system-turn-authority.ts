import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  prepareSessionPrincipalRunAuthority,
  resolveSessionSystemTurnProfileId,
} from "./session-sharing-authorization-async.js";

/** Trusted system admissions act as the session's current principal, never a prior turn's caller. */
export async function prepareSessionSystemTurnAuthority(
  params: Omit<
    Parameters<typeof prepareSessionPrincipalRunAuthority>[0],
    "profileId" | "sessionPrincipal"
  >,
) {
  const entry = await readSessionEntryReadOnlyInWorker(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      projection: "list",
    },
    params.assertCurrent,
  );
  if (entry?.sessionId !== params.sessionId) {
    throw new Error("System turn session is unavailable or has changed.");
  }
  const profileId = resolveSessionSystemTurnProfileId(entry);
  return profileId
    ? prepareSessionPrincipalRunAuthority({ ...params, profileId, sessionPrincipal: true })
    : undefined;
}
