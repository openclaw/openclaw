import { randomUUID } from "node:crypto";
import type { Server, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";

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
function resolveRetryableHistoryDelayMs(error: unknown): number | null {
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
export type GatewayChatRun = Partial<
  Record<"runId" | "status" | "stopReason" | "endedAt", unknown>
>;
export type GatewayChatMessage = { role?: unknown; content?: unknown; text?: unknown };
export type GatewayChatHistory = {
  sessionKey?: string;
  sessionId?: string;
  messages?: GatewayChatMessage[];
};
type Gateway = Pick<QaGatewayChild, "call">;

export const isolatedGatewayEnv = {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
};

export function sendChat(
  gateway: Gateway,
  sessionKey: string,
  message: string,
  options: Record<string, unknown> = {},
) {
  return gateway.call(
    "chat.send",
    { sessionKey, message, deliver: false, idempotencyKey: randomUUID(), ...options },
    { timeoutMs: 30_000 },
  ) as Promise<GatewayChatRun>;
}

export function waitForRun(
  gateway: Gateway,
  runId: unknown,
  timeoutMs = 30_000,
  rpcTimeoutMs = 35_000,
) {
  return gateway.call(
    "agent.wait",
    { runId, timeoutMs },
    { timeoutMs: rpcTimeoutMs },
  ) as Promise<GatewayChatRun>;
}

export async function listenLoopback(server: Server, failure: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(failure);
  }
  return `http://127.0.0.1:${address.port}`;
}

export function writeFixtureReply(
  response: ServerResponse,
  text: string,
  messageId: string,
  responseId: string,
): void {
  const message = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

export async function pollHistory<T>(
  read: () => Promise<T>,
  matches: (history: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
  failure: (latest: T | undefined) => string,
): Promise<T> {
  const startedAt = Date.now();
  let latest: T | undefined;
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    let delayMs = intervalMs;
    try {
      latest = await read();
      lastError = undefined;
      if (matches(latest)) {
        return latest;
      }
    } catch (error) {
      const retryDelay = resolveRetryableHistoryDelayMs(error);
      if (retryDelay === null) {
        throw error;
      }
      lastError = error;
      delayMs = retryDelay;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(delayMs, remainingMs));
  }
  throw lastError === undefined
    ? new Error(failure(latest))
    : new Error(failure(latest), { cause: lastError });
}
