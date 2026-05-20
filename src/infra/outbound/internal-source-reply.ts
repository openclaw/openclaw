export const INTERNAL_SOURCE_REPLY_SINK = "internal-ui" as const;
export type InternalSourceReplySink = typeof INTERNAL_SOURCE_REPLY_SINK;

export const INTERNAL_SOURCE_REPLY_TARGET = "current-run" as const;
export type InternalSourceReplyTarget = typeof INTERNAL_SOURCE_REPLY_TARGET;

export function isInternalSourceReplySink(value: unknown): value is InternalSourceReplySink {
  return value === INTERNAL_SOURCE_REPLY_SINK;
}
