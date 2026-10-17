export function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
}

// Only retry the structured chat.history projection-unavailable response.
export function resolveRetryableHistoryDelayMs(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      break;
    }
    const shaped = current as {
      cause?: unknown;
      code?: unknown;
      details?: unknown;
      gatewayCode?: unknown;
      retryable?: unknown;
      retryAfterMs?: unknown;
    };
    if ((shaped.gatewayCode ?? shaped.code) === "UNAVAILABLE" && shaped.retryable === true) {
      const method =
        typeof shaped.details === "object" && shaped.details !== null
          ? (shaped.details as { method?: unknown }).method
          : undefined;
      if (typeof method !== "string" || method === "chat.history") {
        return typeof shaped.retryAfterMs === "number" && Number.isFinite(shaped.retryAfterMs)
          ? Math.max(100, Math.min(Math.floor(shaped.retryAfterMs), 5_000))
          : 250;
      }
    }
    current = shaped.cause;
  }
  return null;
}
