import { FsSafeError } from "../infra/fs-safe.js";
import { resolveInboundMediaOwnership } from "../media/inbound-media-ownership.js";
import type { MediaProbeResult } from "../media/media-probe.js";
import { parseInboundMediaUri } from "../media/media-reference.js";

/**
 * The staged-media ownership binding the Control UI assistant media route enforces.
 *
 * A managed `media://inbound/<id>` reference names one file the media store owns, so its
 * availability, retryability, and reader authority all follow store facts rather than the
 * local-file policy that governs on-disk paths. These helpers isolate that concern from the
 * request handler: whether a source is a managed reference, how a store miss is reported, and
 * which sessions a staged object stays bound to.
 */

type AssistantMediaAvailability =
  | ({
      available: true;
      mimeType?: string;
      playback?: "native" | "transcode";
      sizeBytes?: number;
    } & MediaProbeResult)
  | { available: false; reason: string; code: string };

/** Resolves the inbound id of a managed media:// reference, or undefined for anything else. */
function managedInboundMediaId(source: string): string | undefined {
  try {
    return parseInboundMediaUri(source)?.id;
  } catch {
    return undefined;
  }
}

function isManagedInboundSource(source: string): boolean {
  return managedInboundMediaId(source) !== undefined;
}

/**
 * Maps a media-open failure to the availability shape the Control UI renders, translating both
 * FsSafeError codes and the tagged errors the media pipeline throws into stable reason codes.
 */
function classifyAssistantMediaError(err: unknown): AssistantMediaAvailability {
  if (err instanceof FsSafeError) {
    switch (err.code) {
      case "not-found":
        return { available: false, code: "file-not-found", reason: "File not found" };
      case "not-file":
        return { available: false, code: "not-a-file", reason: "Not a file" };
      case "invalid-path":
      case "path-mismatch":
      case "symlink":
        return { available: false, code: "invalid-file", reason: "Invalid file" };
      default:
        return {
          available: false,
          code: "attachment-unavailable",
          reason: "Attachment unavailable",
        };
    }
  }
  if (err instanceof Error && "code" in err) {
    // SAFETY: guarded by the "code" in err check above; the value is read as unknown and narrowed below.
    const errorCode = (err as { code?: unknown }).code;
    switch (typeof errorCode === "string" ? errorCode : "") {
      case "unsupported-media-type":
        return { available: false, code: "unsupported-media-type", reason: "Not an image" };
      case "path-not-allowed":
        return {
          available: false,
          code: "outside-allowed-folders",
          reason: "Outside allowed folders",
        };
      case "invalid-file-url":
      case "invalid-path":
      case "unsafe-bypass":
      case "network-path-not-allowed":
      case "invalid-root":
        return { available: false, code: "blocked-local-file", reason: "Blocked local file" };
      case "not-found":
        return { available: false, code: "file-not-found", reason: "File not found" };
      case "not-file":
        return { available: false, code: "not-a-file", reason: "Not a file" };
      default:
        break;
    }
  }
  return { available: false, code: "attachment-unavailable", reason: "Attachment unavailable" };
}

/**
 * A managed inbound reference names one file in our own store, so a path or containment
 * failure on one means the store no longer holds it. Reporting that as a blocked local file
 * sends the reader after a policy they cannot change, so name the file as gone instead; both
 * answers are definitive, only the copy differs.
 */
export function reclassifyManagedInboundAvailability(
  source: string,
  error: unknown,
): AssistantMediaAvailability {
  const classified = classifyAssistantMediaError(error);
  return !classified.available &&
    classified.code === "blocked-local-file" &&
    isManagedInboundSource(source)
    ? { available: false, code: "file-not-found", reason: "File not found" }
    : classified;
}

/**
 * A staged object is bound to the session that published it. The media store is one of the
 * default media roots, so without this a reader who learned the reference could fetch it while
 * naming no session at all, and outlive the visibility of the session whose history published
 * it. An owned reference therefore needs a session that matches its owner, and an ownerless
 * request is refused rather than falling back to general reader authority.
 *
 * Returns `true` when the request may proceed and `false` when it must be refused.
 */
export async function managedInboundOwnershipAllows(
  source: string,
  ...sessionBoundKeys: (string | undefined)[]
): Promise<boolean> {
  if (!isManagedInboundSource(source)) {
    return true;
  }
  const ownership = await resolveInboundMediaOwnership(managedInboundMediaId(source) ?? "");
  if (!ownership) {
    return true;
  }
  return (
    !ownership.sessionKey ||
    sessionBoundKeys.some((candidate) => candidate && candidate === ownership.sessionKey)
  );
}

/**
 * A managed inbound reference lives in our own store, so nothing recreates the file the
 * media-store pruner deleted. A retry can never succeed there, and offering one turns an honest
 * "gone" state into a button that lies; a local path may simply be mid-write, so it keeps its
 * retry.
 */
function isPrunedFromStore(
  source: string,
  availability: AssistantMediaAvailability,
  outsideAllowed: boolean,
): boolean {
  return !availability.available && !outsideAllowed && isManagedInboundSource(source);
}

/**
 * Projects the availability of a meta request into the response body the Control UI renders.
 * An outside-allowed-folders miss is a policy the reader may be able to lift, so it keeps a
 * canAllow hint and is non-retryable; a store-pruned managed reference is definitively gone, so
 * it is non-retryable with no such hint; every other result passes through unchanged.
 */
export function resolveAssistantMediaMetaResponse(
  source: string,
  availability: AssistantMediaAvailability,
  canAllow: boolean,
): AssistantMediaAvailability & { retryable?: false; canAllow?: true } {
  const outsideAllowed = !availability.available && availability.code === "outside-allowed-folders";
  if (outsideAllowed) {
    return { ...availability, retryable: false, ...(canAllow ? { canAllow: true } : {}) };
  }
  if (isPrunedFromStore(source, availability, outsideAllowed)) {
    return { ...availability, retryable: false };
  }
  return availability;
}
