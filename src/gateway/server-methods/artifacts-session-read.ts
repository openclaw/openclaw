import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import {
  ArtifactSessionResolutionError,
  type ArtifactQuery,
  prepareArtifactSessionResolution,
} from "./artifacts-session-resolution.js";
import type { GatewayClient } from "./types.js";

/** Retain the selected physical transcript independently of later query resolution. */
export async function prepareArtifactSessionRead(
  query: ArtifactQuery,
  getRuntimeConfig: () => OpenClawConfig | undefined,
  client: GatewayClient | null,
) {
  const resolveSession = await prepareArtifactSessionResolution(query);
  const resolved = resolveSession(getRuntimeConfig(), client);
  if (!resolved) {
    return undefined;
  }
  const { sessionKey } = resolved;
  const unscopedAgentId = parseAgentSessionKey(sessionKey) ? undefined : resolved.agentId;
  const readEntry = () =>
    unscopedAgentId
      ? loadGatewaySessionEntryReadOnly(sessionKey, { agentId: unscopedAgentId })
      : loadGatewaySessionEntryReadOnly(sessionKey);
  const { storePath, entry } = readEntry();
  const sessionId = entry?.sessionId;
  if (!sessionId || !storePath) {
    return { sessionKey };
  }
  const lifecycleRevision = entry.lifecycleRevision;
  return {
    sessionKey,
    scope: {
      agentId: resolved.agentId ?? resolveAgentIdFromSessionKey(sessionKey),
      sessionEntry: entry,
      sessionId,
      sessionKey,
      storePath,
    } satisfies SessionTranscriptReadScope,
    assertCurrent: () => {
      const authorized = resolveSession(getRuntimeConfig(), client);
      const current = readEntry();
      if (
        authorized?.sessionKey !== sessionKey ||
        authorized.agentId !== resolved.agentId ||
        current.storePath !== storePath ||
        current.entry?.sessionId !== sessionId ||
        current.entry.lifecycleRevision !== lifecycleRevision
      ) {
        throw new ArtifactSessionResolutionError(
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "session changed while reading artifact; reload the conversation",
            { retryable: true },
          ),
        );
      }
    },
  };
}
