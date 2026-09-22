import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readTranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";

const PREFIX = "artifact_transcript_image_";

type TranscriptImageReference = {
  source: string;
  rawSeq: number;
  messageId: string;
  messageSeq: number;
  contentIndex: number;
};

function imageReference(message: Record<string, unknown>, contentIndex: number) {
  const metadata = asOptionalRecord(message["__openclaw"]);
  const position = readTranscriptDisplayPosition(metadata?.transcriptPosition);
  const messageId = metadata?.id;
  const messageSeq = asPositiveSafeInteger(metadata?.seq);
  if (
    !position ||
    typeof messageId !== "string" ||
    !messageId ||
    messageId.length > 1024 ||
    messageSeq === undefined ||
    messageSeq >= Number.MAX_SAFE_INTEGER
  ) {
    return undefined;
  }
  return { source: position.source, rawSeq: position.rawSeq, messageId, messageSeq, contentIndex };
}

function encodeReference(reference: TranscriptImageReference): string {
  return PREFIX + Buffer.from(JSON.stringify(reference)).toString("base64url");
}

export function parseTranscriptImageArtifactId(id: string): TranscriptImageReference | undefined {
  if (!id.startsWith(PREFIX) || id.length > 8192) {
    return undefined;
  }
  try {
    const value = asOptionalRecord(
      JSON.parse(Buffer.from(id.slice(PREFIX.length), "base64url").toString("utf8")),
    );
    if (
      !value ||
      typeof value.source !== "string" ||
      !value.source ||
      value.source.length > 128 ||
      typeof value.messageId !== "string" ||
      !value.messageId ||
      value.messageId.length > 1024 ||
      typeof value.messageSeq !== "number" ||
      !Number.isSafeInteger(value.messageSeq) ||
      value.messageSeq < 1 ||
      value.messageSeq >= Number.MAX_SAFE_INTEGER ||
      typeof value.rawSeq !== "number" ||
      !Number.isSafeInteger(value.rawSeq) ||
      value.rawSeq < 0 ||
      typeof value.contentIndex !== "number" ||
      !Number.isSafeInteger(value.contentIndex) ||
      value.contentIndex < 0
    ) {
      return undefined;
    }
    const reference = {
      source: value.source,
      rawSeq: value.rawSeq,
      messageId: value.messageId,
      messageSeq: value.messageSeq,
      contentIndex: value.contentIndex,
    };
    return encodeReference(reference) === id ? reference : undefined;
  } catch {
    return undefined;
  }
}

function displayContentField(message: Record<string, unknown>): string {
  return message.role === "assistant" && Array.isArray(message[ASSISTANT_DISPLAY_CONTENT_FIELD])
    ? ASSISTANT_DISPLAY_CONTENT_FIELD
    : "content";
}

function hasInlineImagePayload(block: Record<string, unknown>): boolean {
  const source = asOptionalRecord(block.source);
  return (
    block.type === "image" &&
    [block.data, source?.data].some((value) => typeof value === "string" && value.length > 0)
  );
}

/** References retain the reader's physical generation and raw block position before display filtering. */
export function projectTranscriptImageArtifacts(message: unknown): unknown {
  const record = asOptionalRecord(message);
  if (!record) {
    return message;
  }
  const field = displayContentField(record);
  const content = record[field];
  if (!Array.isArray(content)) {
    return message;
  }
  let projected: unknown[] | undefined;
  for (let index = 0; index < content.length; index++) {
    const block = asOptionalRecord(content[index]);
    if (
      !block ||
      !hasInlineImagePayload(block) ||
      (typeof block.url === "string" && block.url.trim())
    ) {
      continue;
    }
    const reference = imageReference(record, index);
    if (!reference) {
      continue;
    }
    projected ??= content.slice();
    projected[index] = { ...block, artifactId: encodeReference(reference) };
  }
  return projected ? { ...record, [field]: projected } : message;
}

export function resolveTranscriptImageArtifactBlock(
  message: unknown,
  id: string,
): Record<string, unknown> | undefined {
  const reference = parseTranscriptImageArtifactId(id);
  const record = asOptionalRecord(message);
  if (!reference || !record) {
    return undefined;
  }
  const current = imageReference(record, reference.contentIndex);
  if (!current || encodeReference(current) !== id) {
    return undefined;
  }
  const content = record[displayContentField(record)];
  const block = Array.isArray(content)
    ? asOptionalRecord(content[reference.contentIndex])
    : undefined;
  return block && hasInlineImagePayload(block) ? block : undefined;
}
