import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as asNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ArtifactsGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { readSessionMessagesPageWithStatsAsync } from "../session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import {
  parseTranscriptImageArtifactId,
  resolveTranscriptImageArtifactBlock,
} from "../transcript-image-artifacts.js";
import {
  type ArtifactLookup,
  resolveBlockDownload,
  resolveMessageRunId,
  resolveMessageTaskId,
} from "./artifacts-content.js";
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
  const page = await readSessionMessagesPageWithStatsAsync(
    { agentId, sessionKey, sessionId: entry.sessionId, sessionEntry: entry, storePath },
    {
      offset: 0,
      beforeSeq: reference.messageSeq + 1,
      maxMessages: 1,
      maxBytes: MAX_PAYLOAD_BYTES - 4096,
    },
  );
  const message = asOptionalRecord(page.messages[0]);
  const block = resolveTranscriptImageArtifactBlock(message, params.artifactId);
  if (
    !message ||
    !block ||
    (params.messageRole && message.role !== params.messageRole) ||
    (params.runId && resolveMessageRunId(message) !== params.runId) ||
    (params.taskId && resolveMessageTaskId(message) !== params.taskId)
  ) {
    return { sessionKey };
  }
  const download = resolveBlockDownload(block, { includeData });
  if (download.mode !== "bytes") {
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
    artifact: {
      id: params.artifactId,
      type: "image",
      title:
        asNonEmptyString(block.title) ??
        asNonEmptyString(block.fileName) ??
        asNonEmptyString(block.alt) ??
        "Image",
      mimeType: download.mimeType ?? "image/png",
      sizeBytes: download.sizeBytes,
      sessionKey,
      messageSeq: reference.messageSeq,
      source: "session-transcript",
      download: { mode: "bytes" },
      ...(download.data !== undefined ? { data: download.data } : {}),
    },
  };
}
