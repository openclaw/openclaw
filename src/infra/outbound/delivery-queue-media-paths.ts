import path from "node:path";
import { hasNonEmptyString as isNonEmptyMediaSource } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveDeliveryQueueMediaDir } from "../../config/paths.js";

export const ARTIFACT_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[A-Za-z0-9]{1,10})?(?:\.part)?$/;

export function spoolRelativePath(
  absolutePath: string,
  stateDir: string | undefined,
): string | null {
  const spoolRoot = path.resolve(resolveDeliveryQueueMediaDir(stateDir));
  const candidate = path.resolve(absolutePath);
  const relative = path.relative(spoolRoot, candidate);
  return relative && !relative.includes(path.sep) && ARTIFACT_NAME_RE.test(relative)
    ? relative
    : null;
}

export function payloadMediaSources(payload: ReplyPayload): string[] {
  const sources: string[] = [];
  if (isNonEmptyMediaSource(payload.mediaUrl)) {
    sources.push(payload.mediaUrl);
  }
  for (const mediaUrl of payload.mediaUrls ?? []) {
    if (isNonEmptyMediaSource(mediaUrl)) {
      sources.push(mediaUrl);
    }
  }
  return sources;
}

/** Absolute spool paths a queue entry still needs in order to replay. */
export function collectEntrySpoolPaths(
  payloads: readonly ReplyPayload[],
  stateDir?: string,
): string[] {
  const paths: string[] = [];
  for (const payload of payloads) {
    for (const source of payloadMediaSources(payload)) {
      if (path.isAbsolute(source) && spoolRelativePath(source, stateDir)) {
        paths.push(path.resolve(source));
      }
    }
  }
  return paths;
}
