// Shared resolution of the media sources a send action declares, so the outbound runner
// and gateway message.action dispatch cannot drift on which attachment gets delivered.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readStringArrayParam, readStringParam } from "../../agents/tools/common.js";

const SEND_MEDIA_ALIAS_PARAM_KEYS = [
  "media",
  "mediaUrl",
  "path",
  "filePath",
  "fileUrl",
  "image",
] as const;

const STRUCTURED_ATTACHMENT_MEDIA_HINT_KEYS = [
  "media",
  "mediaUrl",
  "path",
  "filePath",
  "fileUrl",
  "url",
] as const;

/**
 * Collect every media source a send action declares, in delivery order.
 *
 * The first alias wins for the primary media, then explicit `mediaUrls`, then each
 * `attachments[]` entry. Callers own what they do with the result: the outbound runner
 * sandbox-normalizes the list before assigning it, while gateway dispatch assigns directly.
 */
export function collectSendMediaSources(args: Record<string, unknown>): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizeOptionalString(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    values.push(normalized);
  };
  for (const key of SEND_MEDIA_ALIAS_PARAM_KEYS) {
    const alias = readStringParam(args, key, { trim: false });
    if (alias) {
      push(alias);
      break;
    }
  }
  readStringArrayParam(args, "mediaUrls")?.forEach(push);
  const attachments = args.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!isRecord(attachment)) {
        continue;
      }
      for (const key of STRUCTURED_ATTACHMENT_MEDIA_HINT_KEYS) {
        push(attachment[key]);
      }
    }
  }
  return values;
}

/**
 * Resolve declared media sources into the top-level `media`/`mediaUrls` params.
 *
 * The outbound runner does this itself in `buildSendPayloadParts`, after sandbox
 * normalization. Gateway `message.action` sends never reach that code, so without this a
 * caller-supplied alias or attachment arrives at the channel adapter with no `media` set and
 * is silently dropped. Gateway dispatch calls this to reach the same result.
 */
export function normalizeSendMediaParams(args: Record<string, unknown>): void {
  const values = collectSendMediaSources(args);
  if (values.length === 0) {
    return;
  }
  args.media = values[0];
  args.mediaUrls = [...values];
}
