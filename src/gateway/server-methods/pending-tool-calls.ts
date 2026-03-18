export type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export function parsePendingToolCalls(value: unknown): PendingToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const calls = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      return typeof record.id === "string" &&
        typeof record.name === "string" &&
        typeof record.arguments === "string"
        ? {
            id: record.id,
            name: record.name,
            arguments: record.arguments,
          }
        : null;
    })
    .filter((entry): entry is PendingToolCall => entry !== null);
  return calls.length > 0 ? calls : undefined;
}
