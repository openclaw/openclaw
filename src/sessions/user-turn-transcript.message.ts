// Canonical user input shape and runtime/display projections share the same media metadata.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { readPersistedMediaFacts, type MediaFact } from "../media/media-facts.js";
import { applyInputProvenanceToUserMessage } from "./input-provenance.js";
import {
  normalizeStructuredMediaEntryForTranscript,
  resolveTranscriptMediaPath,
} from "./user-turn-transcript.media-normalize.js";
import { buildPersistedUserTurnMetadata } from "./user-turn-transcript.metadata.js";
import type {
  PersistedUserTurnMediaInput,
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnMessagePersistenceParams,
} from "./user-turn-transcript.types.js";

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
