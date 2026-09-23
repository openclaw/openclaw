export type FixtureEvent = Record<string, unknown>;

export function messageEvent(params: {
  content: unknown;
  id: string;
  parentId?: string | null;
  role: "assistant" | "toolResult" | "user";
  timestamp: number;
}): FixtureEvent {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId ?? null,
    timestamp: params.timestamp,
    message: {
      role: params.role,
      content: params.content,
      timestamp: params.timestamp,
      ...(params.role === "assistant"
        ? {
            api: "messages",
            provider: "anthropic",
            model: "sonnet-4.6",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
          }
        : {}),
    },
  };
}
