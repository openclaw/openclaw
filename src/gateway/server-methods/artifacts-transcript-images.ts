import {
  ErrorCodes,
  errorShape,
  type ArtifactsGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionArtifacts } from "../session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { parseTranscriptImageArtifactId } from "../transcript-image-artifacts.js";
import type { ArtifactLookup } from "./artifacts-content.js";
import {
  ArtifactSessionResolutionError,
  prepareArtifactSessionResolution,
} from "./artifacts-session-resolution.js";
import type { GatewayClient } from "./types.js";

/** Recover only the referenced persisted bitmap; transcript bytes remain in their existing owner. */
export async function findTranscriptImageArtifact(
  params: ArtifactsGetParams,
  getRuntimeConfig: () => OpenClawConfig | undefined,
  includeData: boolean,
  client: GatewayClient | null,
): Promise<ArtifactLookup> {
  const reference = parseTranscriptImageArtifactId(params.artifactId);
  const resolveSession = await prepareArtifactSessionResolution(params);
  const resolved = resolveSession(getRuntimeConfig(), client);
  if (!reference || !resolved) {
    return {};
  }
  const { sessionKey, agentId } = resolved;
  const session = loadGatewaySessionEntryReadOnly(sessionKey, { agentId });
  const { entry, storePath } = session;
  if (!entry?.sessionId || !storePath) {
    return { sessionKey };
  }
  const { artifact } = await readSessionArtifacts(
    { agentId, sessionKey, sessionId: entry.sessionId, sessionEntry: entry, storePath },
    {
      kind: "image",
      sessionKey,
      artifactId: params.artifactId,
      includeData,
      runId: params.runId,
      taskId: params.taskId,
      messageRole: params.messageRole,
    },
  );
  if (!artifact) {
    return { sessionKey };
  }
  return {
    sessionKey,
    // The handler invokes this after every awaited lookup, immediately before publishing bytes.
    assertCurrent: () => {
      const authorized = resolveSession(getRuntimeConfig(), client);
      const current = loadGatewaySessionEntryReadOnly(sessionKey, { agentId });
      if (
        authorized?.sessionKey !== sessionKey ||
        authorized.agentId !== agentId ||
        current.storePath !== storePath ||
        current.entry?.sessionId !== entry.sessionId ||
        current.entry.lifecycleRevision !== entry.lifecycleRevision
      ) {
        throw new ArtifactSessionResolutionError(
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "session changed while reading image; reload the conversation",
            { retryable: true },
          ),
        );
      }
    },
    artifact,
  };
}
