import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";

/** Retained publication/grant callbacks may run outside their admission async context. */
export function captureIncognitoPublicationSessionRead(
  sessionKey: string,
  options: { agentId?: string } = {},
  storePath?: string,
) {
  const memory = getSessionActorStorageBinding({ sessionKey, agentId: options.agentId, storePath });
  if (memory) {
    return () => ({
      canonicalKey: sessionKey,
      agentId: memory.agentId,
      storePath: memory.path,
      entry: memory.actor.snapshot(memory.authority)?.entry,
    });
  }
  const binding = captureIncognitoSessionBinding({
    sessionKey,
    agentId: options?.agentId,
    storePath,
  });
  if (!binding) {
    return undefined;
  }
  const { actor } = binding;
  const source = captureSessionEntryMetadataRead({
    sessionKey,
    agentId: actor.agentId,
    storePath: actor.path,
  });
  return () => ({
    canonicalKey: sessionKey,
    agentId: actor.agentId,
    storePath: actor.path,
    entry: source?.readCurrent(),
  });
}
