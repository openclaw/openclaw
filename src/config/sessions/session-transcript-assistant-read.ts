import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type {
  LatestTranscriptAssistantText,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

/** Latest assistant is a raw-history query, independent of the active tail's role. */
export async function readLatestTranscriptAssistantTextAsync(
  scope: SessionTranscriptReadScope,
): Promise<LatestTranscriptAssistantText | undefined> {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    if (memory.missing) {
      memory.assertCurrent();
      return undefined;
    }
    return memory.read("session.history.latest-assistant", {});
  }
  const receipt = resolveSessionTranscriptReadFence({
    agentId: normalizeAgentId(
      scope.agentId ?? parseAgentSessionKey(scope.sessionKey)?.agentId ?? scope.defaultAgentId,
    ),
    sessionId: scope.sessionId,
  });
  const admission = receipt && structuredClone(receipt);
  return withSessionTranscriptReadSource(scope, async (captured) => {
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
  });
}
