import { Type } from "@sinclair/typebox";
import { ChatSendSessionKeyString, InputProvenanceSchema, NonEmptyString } from "./primitives.js";

export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

export const LogsTailResultSchema = Type.Object(
  {
    file: NonEmptyString,
    cursor: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 0 }),
    lines: Type.Array(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    reset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: ChatSendSessionKeyString,
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    systemInputProvenance: Type.Optional(InputProvenanceSchema),
    systemProvenanceReceipt: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatAbortParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    runId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChatInjectParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: NonEmptyString,
    label: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const ChatEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal("delta"),
      Type.Literal("final"),
      Type.Literal("aborted"),
      Type.Literal("error"),
    ]),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// Chunked file upload protocol
export const FileChunkParamsSchema = Type.Object(
  {
    uploadId: NonEmptyString,
    chunkIndex: Type.Integer({ minimum: 0 }),
    totalChunks: Type.Integer({ minimum: 1 }),
    data: NonEmptyString,
  },
  { additionalProperties: false },
);

export type FileChunkParams = {
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
};

export const FileCompleteParamsSchema = Type.Object(
  {
    uploadId: NonEmptyString,
    filename: NonEmptyString,
    mimeType: NonEmptyString,
    totalSize: Type.Integer({ minimum: 1 }),
    sessionKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export type FileCompleteParams = {
  uploadId: string;
  filename: string;
  mimeType: string;
  totalSize: number;
  sessionKey?: string;
};

export const FileCancelParamsSchema = Type.Object(
  {
    uploadId: NonEmptyString,
  },
  { additionalProperties: false },
);

export type FileCancelParams = {
  uploadId: string;
};
