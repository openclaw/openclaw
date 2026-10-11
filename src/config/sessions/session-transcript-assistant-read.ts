import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type {
  LatestTranscriptAssistantText,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import { loadLatestAssistantText } from "./session-accessor.sqlite-read.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import {
  captureIncognitoSessionHistoryBinding,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import { readIncognitoSessionHistory } from "./session-incognito-history-read.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

/** Latest assistant is a raw-history query, independent of the active tail's role. */
export async function readLatestTranscriptAssistantTextAsync(
  scope: SessionTranscriptReadScope,
): Promise<LatestTranscriptAssistantText | undefined> {
  const source = captureIncognitoSessionSource(scope);
  if (source && "kind" in source) {
    source.assertCurrent();
    return undefined;
  }
  const incognito = captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    return readIncognitoSessionHistory(incognito, scope, (target) => ({
      type: "session.history.latest-assistant",
      input: target,
    }));
  }
  const receipt = resolveSessionTranscriptReadFence({
    agentId: normalizeAgentId(
      scope.agentId ?? parseAgentSessionKey(scope.sessionKey)?.agentId ?? scope.defaultAgentId,
    ),
    sessionId: scope.sessionId,
  });
  const admission = receipt && structuredClone(receipt);
  return withSessionTranscriptReadSource(
    scope,
    (captured) => readRestoredSessionTranscript(captured, () => loadLatestAssistantText(captured)),
    async (captured) => {
      const { owner, expectedIdentity, assertCurrent } = captured;
      if (!expectedIdentity) {
        return undefined;
      }
      const result = await readRestoredSessionTranscript(
        captured.scope,
        () =>
          owner.readLatestAssistant({
            scope: captured.scope,
            resolved: captured.resolved,
            expectedIdentity,
            admission,
          }),
        {
          assertCurrent,
          coldRead: {
            target: captured.resolved,
            readMetadata: async () =>
              (
                await owner.readColdMetadata({
                  sessionId: captured.resolved.sessionId,
                  env: captured.scope.env,
                })
              ).archive,
          },
        },
      );
      assertCurrent();
      return result;
    },
  );
}
