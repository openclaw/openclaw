const OPENCLAW_RUNTIME_ONLY_EVENT_MESSAGE_FLAG = "runtimeOnlyEvent";

type RuntimeOnlyEventMessage = {
  role?: unknown;
  __openclaw?: unknown;
};

function getOpenClawMetadata(message: RuntimeOnlyEventMessage): Record<string, unknown> {
  const metadata = message.__openclaw;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

export function markRuntimeOnlyEventUserMessage<T extends RuntimeOnlyEventMessage>(message: T): T {
  return {
    ...message,
    __openclaw: {
      ...getOpenClawMetadata(message),
      [OPENCLAW_RUNTIME_ONLY_EVENT_MESSAGE_FLAG]: true,
    },
  };
}

export function hasRuntimeOnlyEventUserMessageProvenance(
  message: RuntimeOnlyEventMessage,
): boolean {
  if (message.role !== "user") {
    return false;
  }
  return getOpenClawMetadata(message)[OPENCLAW_RUNTIME_ONLY_EVENT_MESSAGE_FLAG] === true;
}
