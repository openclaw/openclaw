import { readFileWindowFully, safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { detectMime, kindFromMime } from "@openclaw/media-core/mime";
import { startsWithSvgRootElement } from "../../packages/gateway-protocol/src/svg-image.js";
import { openLocalFileSafely } from "../infra/fs-safe.js";
import { assertLocalMediaAllowed, LocalMediaAccessError } from "../media/local-media-access.js";
import { resolveMediaReferenceLocalPathInfo } from "../media/media-reference.js";
import { resolvePlaybackMetadataForSource } from "../media/playback-transcode.js";
import { resolveUserPath } from "../utils.js";
import {
  classifyAssistantMediaError,
  type AssistantMediaAvailability,
} from "./assistant-media-errors.js";
import {
  createAssistantMediaTicket,
  type resolveAssistantMediaPolicy,
  type AssistantMediaTicketPayload,
} from "./assistant-media-policy.js";

export function normalizeAssistantMediaSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  if (/^file:/iu.test(trimmed)) {
    try {
      return safeFileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("~")) {
    return resolveUserPath(trimmed);
  }
  return trimmed;
}

type AssistantMediaPolicy = NonNullable<ReturnType<typeof resolveAssistantMediaPolicy>>;
type AssistantMediaFile = NonNullable<AssistantMediaTicketPayload["file"]>;

function sameAssistantMediaFile(actual: AssistantMediaFile, expected: AssistantMediaFile) {
  return (
    actual.realPath === expected.realPath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
}

export async function openAssistantMedia(
  source: string,
  policy: AssistantMediaPolicy,
  allowance: true | AssistantMediaFile | undefined,
) {
  const reference = await resolveMediaReferenceLocalPathInfo(source);
  if (policy.remote && reference.kind === "local") {
    throw new LocalMediaAccessError("invalid-path", "File is on another computer");
  }
  let outsideRoots = false;
  try {
    await assertLocalMediaAllowed(reference.path, policy.localRoots);
  } catch (error) {
    if (!(error instanceof LocalMediaAccessError) || error.code !== "path-not-allowed") {
      throw error;
    }
    outsideRoots = true;
    if (policy.workspaceOnly && !allowance) {
      throw error;
    }
  }
  const opened = await openLocalFileSafely({ filePath: reference.path });
  try {
    let file: AssistantMediaFile | undefined;
    if (outsideRoots && allowance) {
      const identity = await opened.handle.stat({ bigint: true });
      const candidate = {
        realPath: opened.realPath,
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
      };
      if (allowance === true || sameAssistantMediaFile(candidate, allowance)) {
        file = candidate;
      } else if (policy.workspaceOnly) {
        // Replacing an allowed image loses the grant; offer the same explicit choice again.
        throw new LocalMediaAccessError("path-not-allowed", "Outside allowed folders");
      }
    }
    // Validate the descriptor target too: a symlink may change between containment and open.
    if (!outsideRoots) {
      await assertLocalMediaAllowed(opened.realPath, policy.localRoots);
    }
    const sniffBuffer = Buffer.alloc(Math.min(opened.stat.size, 8192));
    const bytesRead = sniffBuffer.length
      ? await readFileWindowFully(opened.handle, sniffBuffer, 0)
      : 0;
    const buffer = sniffBuffer.subarray(0, bytesRead);
    const mimeType = startsWithSvgRootElement(buffer.toString("utf8"))
      ? "image/svg+xml"
      : await detectMime({ buffer, ...(outsideRoots ? {} : { filePath: reference.path }) });
    // Host-wide reads authorize actual image bytes, never a filename's extension.
    if (outsideRoots && kindFromMime(mimeType) !== "image") {
      throw new LocalMediaAccessError("unsupported-media-type", "Not an image");
    }
    return { opened, reference, mimeType, outsideRoots, file };
  } catch (error) {
    await opened.handle.close().catch(() => {});
    throw error;
  }
}

export async function resolveAssistantMediaAvailability(
  source: string,
  policy: AssistantMediaPolicy,
  allowance: true | AssistantMediaFile | undefined,
  agentId: string | undefined,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<AssistantMediaAvailability & { mediaTicket?: string; mediaTicketExpiresAt?: string }> {
  try {
    assertCurrent();
    const { opened, mimeType, file } = await openAssistantMedia(source, policy, allowance);
    // The inspection owner reopens and verifies this identity after queue admission.
    await opened[Symbol.asyncDispose]();
    const mediaKind = kindFromMime(mimeType);
    const playbackMetadata =
      mimeType && (mediaKind === "audio" || mediaKind === "video")
        ? await resolvePlaybackMetadataForSource({
            sourcePath: opened.realPath,
            sourceStat: opened.stat,
            mimeType,
            kind: mediaKind,
            signal,
            assertCurrent,
          })
        : undefined;
    assertCurrent();
    return {
      available: true,
      ...(mimeType ? { mimeType } : {}),
      sizeBytes: opened.stat.size,
      ...playbackMetadata,
      ...createAssistantMediaTicket({
        source,
        agentId,
        session: policy.session,
        reader: policy.reader,
        ...(file ? { file } : {}),
      }),
    };
  } catch (error) {
    return classifyAssistantMediaError(error);
  }
}
