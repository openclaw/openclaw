import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  ArtifactSessionResolutionError,
  type ArtifactQuery,
  type ArtifactSessionAccess,
  prepareArtifactSessionResolution,
} from "./artifacts-session-resolution.js";

/** Authorization and transcript reads retain the same selected physical target. */
export async function prepareArtifactSessionRead(
  query: ArtifactQuery,
  access: ArtifactSessionAccess,
) {
  const resolveSession = await prepareArtifactSessionResolution(query, access.projection);
  const selected = await resolveSession(access);
  if (!selected) {
    return undefined;
  }
  const { sessionKey, release } = selected;
  const initial = selected.readCurrent();
  const { target } = initial;
  const entry = target?.entry;
  const sessionId = entry?.sessionId;
  const storePath = initial.sourcePath ?? target?.storePath;
  const lifecycleRevision = entry?.lifecycleRevision;
  const assertCurrent = () => {
    const current = selected.readCurrent();
    if (
      (current.sourcePath ?? current.target?.storePath) !== storePath ||
      current.target?.entry.sessionId !== sessionId ||
      current.target?.entry.lifecycleRevision !== lifecycleRevision
    ) {
      throw new ArtifactSessionResolutionError(
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "session changed while reading artifact; reload the conversation",
          { retryable: true },
        ),
      );
    }
  };
  if (!sessionId || !storePath) {
    return { sessionKey, assertCurrent, release };
  }
  return {
    sessionKey,
    scope: {
      agentId: initial.sourceAgentId ?? selected.agentId,
      sessionEntry: entry,
      sessionId,
      sessionKey,
      storePath,
    } satisfies SessionTranscriptReadScope,
    assertCurrent,
    release,
  };
}
