import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { parseInboundMediaUri } from "../media/inbound-media-uri.js";
import {
  isImageMediaFact,
  isMeaningfulMediaFact,
  readPersistedMediaFacts,
} from "../media/media-facts.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import { publicSessionMessageEntry } from "./control-ui-public-session-message.js";
import type { PublicSessionShareLocator } from "./control-ui-public-session-token.js";

export type PublicSessionAttachment = { id: string; name: string; image: boolean };
type Attachment = PublicSessionAttachment & { source?: string; path?: string; data?: string };

export function getPublicSessionEntryId(message: unknown): string | undefined {
  const id = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id;
  return typeof id === "string" && id.length > 0 && id.length <= 1024 ? id : undefined;
}

export function buildPublicSessionMediaBaseUrl(basePath: string, token: string): string {
  return `${basePath}/share/session/media?token=${encodeURIComponent(token)}`;
}

export function buildPublicSessionMediaUrl(baseUrl: string, entryId: string, attachmentId: string) {
  return `${baseUrl}&entry=${encodeURIComponent(entryId)}&attachment=${encodeURIComponent(attachmentId)}`;
}

function attachmentSource(block: Record<string, unknown>) {
  const source = asOptionalRecord(block.source);
  const imageUrl = asOptionalRecord(block.image_url);
  const attachment = asOptionalRecord(block.attachment);
  const url = [
    block.url,
    block.openUrl,
    source?.url,
    block.image_url,
    imageUrl?.url,
    attachment?.url,
  ].find((value): value is string => typeof value === "string" && value.length > 0);
  const data = [block.data, source?.data].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return { source: url, data };
}

function collectAttachments(message: unknown): Attachment[] {
  const record = publicSessionMessageEntry(message);
  if (!record) {
    return [];
  }
  const attachments: Attachment[] = [];
  const displayContent = record[ASSISTANT_DISPLAY_CONTENT_FIELD];
  const content = Array.isArray(displayContent) ? displayContent : record.content;
  for (const [index, contentBlock] of (Array.isArray(content) ? content : []).entries()) {
    const block = asOptionalRecord(contentBlock);
    if (!block) {
      continue;
    }
    const attachment = asOptionalRecord(block.attachment);
    const image = ["image", "image_url", "input_image"].includes(String(block.type));
    if (!image && block.type !== "attachment" && block.type !== "file") {
      continue;
    }
    if (
      (record.role === "toolResult" || record.role === "tool") &&
      !image &&
      attachment?.kind !== "image"
    ) {
      continue;
    }
    const name = [block.fileName, attachment?.name, attachment?.label, block.alt].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    attachments.push({
      id: `content-${index}`,
      name: name ?? (image ? "Image" : "Attachment"),
      image: image || attachment?.kind === "image",
      ...attachmentSource(block),
    });
  }
  for (const [index, fact] of (readPersistedMediaFacts(record) ?? []).entries()) {
    if (!isMeaningfulMediaFact(fact)) {
      continue;
    }
    const image = isImageMediaFact(fact);
    if ((record.role === "toolResult" || record.role === "tool") && !image) {
      continue;
    }
    attachments.push({
      id: `media-${index}`,
      name: fact.fileName || (image ? "Image" : "Attachment"),
      image,
      source: fact.url ?? fact.path,
      path: fact.path,
    });
  }
  return attachments;
}

/** Only descriptors leave the projection; media bytes are recovered after public authorization. */
export function collectPublicSessionAttachments(message: unknown): PublicSessionAttachment[] {
  return collectAttachments(message).map(({ id, name, image }) => ({ id, name, image }));
}

export async function readPublicSessionAttachment(
  message: unknown,
  attachmentId: string,
  locator: PublicSessionShareLocator,
): Promise<Buffer | null> {
  const attachment = collectAttachments(message).find((item) => item.id === attachmentId);
  if (!attachment?.image) {
    return null;
  }
  let data = attachment.data;
  if (attachment.source?.startsWith("data:")) {
    const match = /^data:image\/[a-z0-9.+-]+;base64,/iu.exec(attachment.source);
    data = match ? attachment.source.slice(match[0].length) : undefined;
  }
  if (data) {
    if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
      return null;
    }
    const buffer = Buffer.from(data, "base64");
    return buffer.byteLength <= MAX_IMAGE_BYTES ? buffer : null;
  }
  if (!attachment.source) {
    return null;
  }
  try {
    const { buildInboundMediaUriFromPath } = await import("../media/media-reference.js");
    const inbound = parseInboundMediaUri(
      buildInboundMediaUriFromPath(attachment.path ?? attachment.source) ?? attachment.source,
    );
    if (inbound) {
      const { readMediaBuffer } = await import("../media/store.js");
      return (await readMediaBuffer(inbound.id, "inbound", MAX_IMAGE_BYTES)).buffer;
    }
    const { parseManagedOutgoingRoute } = await import("./managed-image-attachments.js");
    const outgoing = parseManagedOutgoingRoute(attachment.source);
    if (!outgoing || outgoing.sessionKey !== locator.sessionKey) {
      return null;
    }
    const { readManagedImageRecord } = await import("./managed-image-record-store.js");
    const record = await readManagedImageRecord(outgoing.attachmentId);
    if (
      !record ||
      record.sessionKey !== locator.sessionKey ||
      record.messageId !== getPublicSessionEntryId(message) ||
      (record.agentId !== undefined && record.agentId !== locator.agentId)
    ) {
      return null;
    }
    const { resolveManagedImageOriginalPath } =
      await import("./managed-image-attachments.custody.js");
    const { readLocalFileSafely } = await import("../infra/fs-safe.js");
    const loaded = await readLocalFileSafely({
      filePath: resolveManagedImageOriginalPath(record),
      maxBytes: MAX_IMAGE_BYTES,
    });
    return loaded.buffer;
  } catch {
    return null;
  }
}
