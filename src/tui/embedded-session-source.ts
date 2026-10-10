import { getRuntimeConfig } from "../config/config.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import { withGatewaySessionEntryReadOnly } from "../gateway/session-utils-read-lifetime.js";
import type { loadGatewaySessionEntryReadOnly } from "../gateway/session-utils.js";

export type SelectedEmbeddedSession = ReturnType<typeof loadGatewaySessionEntryReadOnly>;

/** Native local mode keeps its owner until runtime acquisition supplies an actor binding. */
export function withEmbeddedSessionSource<T>(
  sessionKey: string,
  agentId: string | undefined,
  consume: (
    selected: SelectedEmbeddedSession | undefined,
    assertSelected: () => void,
  ) => Promise<T>,
): Promise<T> {
  const binding = captureIncognitoSessionSource({ sessionKey, agentId });
  if (!binding) {
    return consume(undefined, () => {});
  }
  return withGatewaySessionEntryReadOnly(
    { cfg: getRuntimeConfig(), key: sessionKey, agentId },
    (selected, assertCurrent) => {
      const assertSelected = captureSessionEntrySourceAssertion({
        scope: {
          agentId: selected.agentId,
          sessionKey: selected.canonicalKey,
          storePath: selected.storePath,
        },
        expected: selected.entry,
        fields: ["sessionId", "lifecycleRevision"],
        assertCurrent,
        refuse() {
          throw new Error("Local session changed during the request");
        },
      });
      return consume(selected, assertSelected);
    },
  );
}
