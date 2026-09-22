import { getRuntimeConfig } from "../config/config.js";
import {
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  parseManagedOutgoingRoute,
  readManagedOutgoingImageThumbnail,
} from "../gateway/managed-image-attachments.js";
import { resolveRequestedSessionAgentId } from "../gateway/session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "../gateway/session-utils.js";
import { parseInboundMediaUri } from "../media/media-reference.js";
import { readMediaBuffer } from "../media/store.js";
import type { TuiImageData, TuiImageRequest } from "./tui-backend.js";
import { decodeTuiImageData, prepareTuiImage, TUI_IMAGE_MAX_BYTES } from "./tui-image-data.js";

export async function loadEmbeddedImage(request: TuiImageRequest): Promise<TuiImageData> {
  const { signal } = request;
  signal.throwIfAborted();
  const inline = decodeTuiImageData(request.source);
  if (inline) {
    return await prepareTuiImage(inline, signal);
  }
  const owner = resolveRequestedSessionAgentId(
    getRuntimeConfig(),
    request.sessionKey,
    request.agentId,
  );
  if (!owner.ok) {
    throw new Error(owner.error.message);
  }
  const { canonicalKey, agentId, entry } = loadGatewaySessionEntryReadOnly(request.sessionKey, {
    agentId: owner.agentId,
  });
  if (!entry?.sessionId) {
    throw new Error("Image session is unavailable");
  }
  const inbound = parseInboundMediaUri(request.source);
  if (inbound) {
    const { buffer } = await readMediaBuffer(inbound.id, "inbound", TUI_IMAGE_MAX_BYTES);
    return await prepareTuiImage(buffer, signal);
  }
  const managed = request.source.startsWith("/api/chat/media/outgoing/")
    ? parseManagedOutgoingRoute(request.source)
    : null;
  if (!managed || managed.sessionKey !== canonicalKey) {
    throw new Error("Image source is not managed by this session");
  }
  const artifactId = `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${managed.attachmentId}`;
  if (request.artifactId && request.artifactId !== artifactId) {
    throw new Error("Image artifact does not match its source");
  }
  const buffer = await readManagedOutgoingImageThumbnail({
    sessionKey: canonicalKey,
    agentId,
    artifactId,
    maxBytes: TUI_IMAGE_MAX_BYTES,
    signal,
  });
  if (!buffer) {
    throw new Error("Image artifact is unavailable");
  }
  return await prepareTuiImage(buffer, signal);
}
