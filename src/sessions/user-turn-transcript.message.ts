// Canonical user input shape and runtime/display projections share the same media metadata.
import path from "node:path";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import {
  asFiniteNumberInRange,
  asPositiveSafeInteger,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import {
  readPersistedMediaFacts,
  type MediaFact,
  type MediaFactInput,
} from "../media/media-facts.js";
import { applyInputProvenanceToUserMessage } from "./input-provenance.js";
import { buildPersistedUserTurnMetadata } from "./user-turn-transcript.metadata.js";
import type {
  PersistedUserTurnMediaInput,
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnMessagePersistenceParams,
} from "./user-turn-transcript.types.js";

const URL_LIKE_MEDIA_PATH_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const STRUCTURED_MEDIA_KINDS = new Set<string>([
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "unknown",
]);
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu;

function isStructuredMediaKind(
  kind: string | undefined,
): kind is NonNullable<MediaFactInput["kind"]> {
  return kind !== undefined && STRUCTURED_MEDIA_KINDS.has(kind);
}

function resolveTranscriptMediaPath(pathValue: string, workspaceDir: string | undefined): string {
  // Relative staged media paths are anchored to the media workspace; absolute
  // paths and URL-like refs are already stable transcript references.
  if (!workspaceDir || path.isAbsolute(pathValue) || URL_LIKE_MEDIA_PATH_PATTERN.test(pathValue)) {
    return pathValue;
  }
  return path.join(workspaceDir, pathValue);
}

function normalizeStructuredMediaEntryForTranscript(
  media: PersistedUserTurnMediaInput,
): MediaFactInput {
  const workspaceDir = normalizeOptionalString(media.workspaceDir);
  const mediaPath = normalizeOptionalString(media.path);
  const mediaUrl = normalizeOptionalString(media.url);
  const legacyKind = normalizeOptionalString(media.kind);
  const kind = isStructuredMediaKind(legacyKind) ? legacyKind : undefined;
  const messageId = normalizeOptionalString(media.messageId);
  const contentType =
    normalizeOptionalString(media.contentType) ??
    (kind || !legacyKind || !MIME_TYPE_PATTERN.test(legacyKind) ? undefined : legacyKind) ??
    mimeTypeFromFilePath(mediaPath ?? mediaUrl);
  const durationMs = asPositiveSafeInteger(media.durationMs);
  const width = asPositiveSafeInteger(media.width);
  const height = asPositiveSafeInteger(media.height);
  const fileName = normalizeOptionalString(media.fileName);
  const sizeBytes = asFiniteNumberInRange(media.sizeBytes, { min: 0 });
  return {
    ...(mediaPath ? { path: resolveTranscriptMediaPath(mediaPath, workspaceDir) } : {}),
    ...(mediaUrl ? { url: mediaUrl } : {}),
    ...(contentType ? { contentType } : {}),
    ...(kind ? { kind } : {}),
    ...(fileName ? { fileName } : {}),
    ...(media.origin === "paste" || media.origin === "file" ? { origin: media.origin } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(media.transcribed === true ? { transcribed: true } : {}),
    ...(messageId ? { messageId } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(media.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
}

export function resolvePersistedUserTurnText(value: string | null | undefined): string | undefined {
  return normalizeOptionalString(value);
}

export function buildPersistedUserTurnMediaInputsFromFields(
  fields: PersistedUserTurnMessage | null | undefined,
): PersistedUserTurnMediaInput[] {
  const facts = fields ? (readPersistedMediaFacts(fields) ?? []) : [];
  const normalizedMedia = facts.map<PersistedUserTurnMediaInput>((fact) => {
    const mediaPath = fact.path
      ? resolveTranscriptMediaPath(fact.path, fact.workspaceDir)
      : undefined;
    const url = fact.url;
    if (!mediaPath && !url) {
      return {};
    }
    const media: PersistedUserTurnMediaInput = {
      contentType: fact.contentType ?? mimeTypeFromFilePath(mediaPath ?? url),
    };
    if (mediaPath) {
      media.path = mediaPath;
    }
    if (url) {
      media.url = url;
    }
    if (fact.kind) {
      media.kind = fact.kind;
    }
    if (fact.fileName) {
      media.fileName = fact.fileName;
    }
    if (fact.origin) {
      media.origin = fact.origin;
    }
    if (fact.sizeBytes !== undefined) {
      media.sizeBytes = fact.sizeBytes;
    }
    if (fact.durationMs !== undefined) {
      media.durationMs = fact.durationMs;
    }
    if (fact.width !== undefined) {
      media.width = fact.width;
    }
    if (fact.height !== undefined) {
      media.height = fact.height;
    }
    return media;
  });
  return normalizedMedia.some((entry) => entry.path || entry.url) ? normalizedMedia : [];
}

export function buildLateMediaAttachedProjection(message: AgentMessage): {
  text?: string;
  media: MediaFact[];
} {
  const isLateMedia = readOpenClawMessageMeta(message)?.lateMedia === true;
  const media = isLateMedia ? (readPersistedMediaFacts(message) ?? []) : [];
  const text = media
    .flatMap((fact) => {
      const mediaRef = fact.path ?? fact.url;
      return mediaRef ? [`[media attached: ${mediaRef}]`] : [];
    })
    .join("\n");
  return { ...(text ? { text } : {}), media };
}

function readOpenClawMessageMeta(message: AgentMessage): Record<string, unknown> | undefined {
  return asOptionalRecord(Reflect.get(message, "__openclaw"));
}

export function readModelPromptProjection(message: unknown): string | undefined {
  if (!isUserMessage(message)) {
    return undefined;
  }
  const metadata = readOpenClawMessageMeta(message);
  if (!metadata || !Object.hasOwn(metadata, "modelPromptProjection")) {
    return undefined;
  }
  const projection = asOptionalRecord(metadata.modelPromptProjection);
  if (projection?.version !== 1 || typeof projection.text !== "string") {
    throw new Error(
      "Unsupported or invalid user-turn model prompt projection; update OpenClaw to a compatible version or start a new session.",
    );
  }
  return projection.text;
}

export function projectRecordedModelPrompt(
  message: AgentMessage,
  transcript?: AgentMessage,
): AgentMessage {
  if (!isUserMessage(message)) {
    return message;
  }
  const text = readModelPromptProjection(transcript) ?? readModelPromptProjection(message);
  if (text === undefined) {
    return message;
  }
  let content = message.content;
  if (Array.isArray(content)) {
    let replaced = false;
    content = content.map((block) => {
      if (block.type !== "text" || replaced) {
        return block;
      }
      replaced = true;
      return { ...block, text };
    });
    if (!replaced) {
      content = [{ type: "text", text }, ...content];
    }
  } else {
    content = text;
  }
  const metadata = { ...message["__openclaw"] };
  delete metadata.modelPromptProjection;
  const projected: PersistedUserTurnMessage = {
    ...message,
    content,
    timestamp: transcript?.role === "user" ? transcript.timestamp : message.timestamp,
  };
  delete projected["__openclaw"];
  if (Object.keys(metadata).length > 0) {
    projected["__openclaw"] = metadata;
  }
  return projected;
}

export function buildPersistedUserTurnMessage(params: UserTurnInput): PersistedUserTurnMessage {
  const normalizedMedia = (params.media ?? []).map(normalizeStructuredMediaEntryForTranscript);
  const text = params.text ?? "";
  // Keep stored content bare: normalizeMessagesForLlmBoundary stamps current and
  // historical turns alike from their own timestamp (#3658).
  const openClawMeta = buildPersistedUserTurnMetadata(params, normalizedMedia);
  const message: PersistedUserTurnMessage = {
    role: "user",
    ...(params.display === false ? { display: false } : {}),
    ...(params.excludeFromContext ? { excludeFromContext: true } : {}),
    content: text,
    timestamp: params.timestamp ?? Date.now(),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(Object.keys(openClawMeta).length > 0 ? { __openclaw: openClawMeta } : {}),
  };
  return applyInputProvenanceToUserMessage(message, params.provenance);
}

export function resolvePersistedUserTurnMessage(
  params: Pick<UserTurnMessagePersistenceParams, "input" | "message">,
): PersistedUserTurnMessage | undefined {
  return params.message ?? (params.input ? buildPersistedUserTurnMessage(params.input) : undefined);
}

export function isUserMessage(message: unknown): message is PersistedUserTurnMessage {
  return asOptionalRecord(message)?.role === "user";
}

export function buildLateResolvedMediaMessage(params: {
  admittedMessage?: PersistedUserTurnMessage;
  resolvedMessage: PersistedUserTurnMessage;
}): PersistedUserTurnMessage | undefined {
  const admittedMedia = buildPersistedUserTurnMediaInputsFromFields(params.admittedMessage);
  const resolvedMedia = buildPersistedUserTurnMediaInputsFromFields(params.resolvedMessage);
  if (
    resolvedMedia.length === 0 ||
    JSON.stringify(resolvedMedia) === JSON.stringify(admittedMedia)
  ) {
    return undefined;
  }
  const resolvedIdempotencyKey = Reflect.get(params.resolvedMessage, "idempotencyKey");
  const resolvedTimestamp = Reflect.get(params.resolvedMessage, "timestamp");
  const admittedContent = params.admittedMessage?.content;
  const resolvedContent = params.resolvedMessage.content;
  let content = resolvedContent;
  if (resolvedContent === admittedContent) {
    content = "";
  } else if (Array.isArray(resolvedContent) && typeof admittedContent === "string") {
    content = resolvedContent.filter((block) => {
      const textBlock = asOptionalRecord(block);
      return textBlock?.type !== "text" || textBlock.text !== admittedContent;
    });
  }
  const idempotencyKey =
    typeof resolvedIdempotencyKey === "string" && resolvedIdempotencyKey.length > 0
      ? `${resolvedIdempotencyKey}:late-media`
      : `late-media:${typeof resolvedTimestamp === "number" ? resolvedTimestamp : Date.now()}`;
  const metadata: Record<string, unknown> = {
    ...readOpenClawMessageMeta(params.resolvedMessage),
    lateMedia: true,
  };
  delete metadata.humanMentions;
  delete metadata.modelPromptProjection;
  // Like #111204, mark late-media scaffolding as wire-only so UIs never render it.
  return {
    ...params.resolvedMessage,
    content,
    idempotencyKey,
    __openclaw: metadata,
  };
}

// Runtime messages may lack transcript metadata because channel adapters prepare
// display text separately. Merge only safe user messages, never block markers.
export function mergePreparedUserTurnMessageForRuntime(params: {
  runtimeMessage: AgentMessage;
  preparedMessage?: PersistedUserTurnMessage;
}): AgentMessage {
  if (
    !params.preparedMessage ||
    !isUserMessage(params.runtimeMessage) ||
    readOpenClawMessageMeta(params.runtimeMessage)?.beforeAgentRunBlocked !== undefined
  ) {
    return params.runtimeMessage;
  }
  const runtimeMeta = readOpenClawMessageMeta(params.runtimeMessage);
  const preparedMeta = readOpenClawMessageMeta(params.preparedMessage);
  return {
    ...params.runtimeMessage,
    ...params.preparedMessage,
    ...(preparedMeta ? { __openclaw: { ...runtimeMeta, ...preparedMeta } } : {}),
    ...(Array.isArray(params.runtimeMessage.content) &&
    params.runtimeMessage.content.some((block) => asOptionalRecord(block)?.type === "image")
      ? { content: params.runtimeMessage.content }
      : {}),
  };
}
