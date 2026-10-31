import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export function mapChatDisplayMessages<T>(messages: T[], project: (message: T) => T): T[] {
  let projected: T[] | undefined;
  messages.forEach((message, index) => {
    const next = project(message);
    if (next !== message) {
      projected ??= messages.slice();
      projected[index] = next;
    }
  });
  return projected ?? messages;
}

export function joinChatDisplayMessage(
  projected: Array<Record<string, unknown>>,
  includeCommentaryFallbacks = false,
): Record<string, unknown> | undefined {
  if (!includeCommentaryFallbacks || !projected.some((entry) => entry.openclawStreamFallback)) {
    return projected[0];
  }
  // A fetched source row restores all its visible fragments as one message.
  const result: Record<string, unknown> = {
    ...projected.at(-1),
    content: projected.flatMap(({ content }) =>
      Array.isArray(content)
        ? content
        : typeof content === "string"
          ? [{ type: "text", text: content }]
          : [],
    ),
  };
  const truncated = projected
    .map((entry) => asOptionalRecord(entry["__openclaw"]))
    .find((metadata) => metadata?.truncated === true);
  if (truncated) {
    result["__openclaw"] = {
      ...asOptionalRecord(result["__openclaw"]),
      truncated: true,
      reason: truncated.reason,
    };
  }
  delete result.openclawStreamFallback;
  return result;
}
