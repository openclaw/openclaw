import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import { onceMessage, type rpcReq } from "./test-helpers.js";

export async function readWarmChatStartup(
  ws: Parameters<typeof rpcReq>[0],
  params: Record<string, unknown>,
) {
  // rpcReq resets the runtime config before each request. Warm startup must reuse
  // the exact config that prepared metadata, as an ordinary client does.
  const config = getRuntimeConfig();
  const id = randomUUID();
  const response = onceMessage<{
    type: string;
    id: string;
    ok: boolean;
    payload?: {
      metadata?: {
        commands?: Array<{ name?: string; textAliases?: string[] }>;
        models?: Array<{ id?: string; provider?: string }>;
      };
      messages?: unknown[];
      sessionInfo?: { key?: string; sessionId?: string };
    };
  }>(ws, (message) => message.type === "res" && message.id === id);
  ws.send(JSON.stringify({ type: "req", id, method: "chat.startup", params }));
  const result = await response;
  expect(getRuntimeConfig()).toBe(config);
  return result;
}
