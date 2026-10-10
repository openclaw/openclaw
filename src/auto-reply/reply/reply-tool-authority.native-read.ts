import type { PreparedToolAuthorityRead } from "../../agents/harness/host-private-capabilities.js";
import { readIncognitoSessionEntryCurrent } from "../../config/sessions/session-accessor.sqlite-incognito-sharing.js";
import { captureNativeSessionEntryCurrentRead } from "../../config/sessions/session-entry-current-runtime.js";
import { assertCapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import { captureIncognitoSessionBinding } from "../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";

/** Retain process-native lineage without reading SQLite inside final admission. */
export function prepareNativeReplyToolAuthorityRead(
  original: {
    agentId: string;
    storePath: string;
    canonicalKey: string;
    source: CapturedSessionEntryReadSource | undefined;
    sessionId: string | undefined;
    lifecycleRevision: SessionEntry["lifecycleRevision"];
  },
  assertActive: () => void,
): PreparedToolAuthorityRead {
  const scope = {
    agentId: original.agentId,
    storePath: original.storePath,
    sessionKey: original.canonicalKey,
  };
  const current = captureIncognitoSessionBinding(scope)
    ? captureNativeSessionEntryCurrentRead(scope)
    : undefined;
  const owner = current
    ? undefined
    : getOpenIncognitoAgentDatabase(original.agentId, original.storePath);
  const assertNativeCurrent = () => {
    assertActive();
    if (!current) {
      if (
        getOpenIncognitoAgentDatabase(original.agentId, original.storePath) !== owner ||
        (!original.source && owner)
      ) {
        throw new Error("Tool authority classification source changed");
      }
      if (original.source) {
        assertCapturedSessionEntryReadSource(original.source, owner);
      }
    }
    const entry = current
      ? current.readCurrent()
      : owner
        ? readIncognitoSessionEntryCurrent(owner.db, original.canonicalKey)
        : undefined;
    if (
      entry?.sessionId !== original.sessionId ||
      entry?.lifecycleRevision !== original.lifecycleRevision
    ) {
      throw new Error("Tool authority classification session changed");
    }
    assertActive();
  };
  assertNativeCurrent();
  return {
    reads: [],
    assertPrepared: assertNativeCurrent,
    assertLegacyCurrent: assertNativeCurrent,
  };
}
