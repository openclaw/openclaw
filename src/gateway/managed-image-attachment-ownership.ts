import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../config/paths.js";
import { captureChannelReadScope } from "../shared/channel-read-authority.js";
import { attachManagedImageRecordToMessage } from "./managed-image-record-store.js";

export const MANAGED_OUTGOING_ATTACHMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseManagedOutgoingRoute(value: string) {
  try {
    const parsed = new URL(value, "http://localhost");
    const match = parsed.pathname.match(/^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/full$/);
    if (!match) {
      return null;
    }
    if (
      !MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(
        expectDefined(match[2], "managed image attachments regex capture 2"),
      )
    ) {
      return null;
    }
    return {
      sessionKey: decodeURIComponent(
        expectDefined(match[1], "managed image attachments regex capture 1"),
      ),
      attachmentId: expectDefined(match[2], "managed image attachments regex capture 2"),
    };
  } catch {
    return null;
  }
}

export function collectManagedOutgoingAttachmentRefs(
  blocks: readonly Record<string, unknown>[] | undefined,
  expectedSessionKey?: string,
) {
  const refs = new Map<string, { attachmentId: string; sessionKey: string }>();
  for (const block of blocks ?? []) {
    const attachment =
      block?.type === "attachment" ? asOptionalRecord(block.attachment) : undefined;
    if (
      block?.type !== "image" &&
      block?.type !== "audio" &&
      block?.type !== "video" &&
      !attachment
    ) {
      continue;
    }
    for (const candidate of [block.url, block.openUrl, attachment?.url]) {
      if (typeof candidate !== "string") {
        continue;
      }
      const parsed = parseManagedOutgoingRoute(candidate);
      if (!parsed) {
        continue;
      }
      if (expectedSessionKey && parsed.sessionKey !== expectedSessionKey) {
        continue;
      }
      const attachmentId = expectDefined(parsed.attachmentId, "managed image attachment id");
      refs.set(attachmentId, {
        attachmentId,
        sessionKey: parsed.sessionKey,
      });
    }
  }
  return [...refs.values()];
}

export async function attachManagedOutgoingMediaToMessage(params: {
  messageId: string;
  blocks?: readonly Record<string, unknown>[];
  stateDir?: string;
  assertCurrent?: () => void;
}) {
  const readScope = captureChannelReadScope();
  const assertCurrent = params.assertCurrent;
  const stateDir = params.stateDir ?? resolveStateDir();
  const messageId = params.messageId.trim();
  if (!messageId) {
    return false;
  }
  const refs = collectManagedOutgoingAttachmentRefs(params.blocks);
  if (refs.length === 0) {
    return false;
  }
  // The transcript commit transfers these exact outputs out of read cancellation.
  // Start every acceptance synchronously before file teardown or promotion can yield.
  assertCurrent?.();
  if (readScope) {
    await Promise.all(
      refs.map(({ attachmentId }) =>
        readScope.acceptResource(`managed-media-record:${stateDir}:${attachmentId}`),
      ),
    );
  }
  let attached = true;
  for (const { attachmentId, sessionKey } of refs) {
    const current = await attachManagedImageRecordToMessage({
      attachmentId,
      sessionKey,
      messageId,
      updatedAt: new Date().toISOString(),
      stateDir,
      assertCurrent,
    });
    attached = current && attached;
  }
  return attached;
}
