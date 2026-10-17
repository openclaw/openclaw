import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import type { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export async function seedHistorySession(id: string, entry: Partial<InternalSessionEntry> = {}) {
  const scope = { agentId: "main", sessionKey: `agent:main:${id}`, sessionId: id };
  await upsertSessionEntryCore(scope, { sessionId: id, updatedAt: 1, ...entry });
  return scope;
}

export function historyRpc(
  context: Awaited<ReturnType<typeof createHistoryReadContext>>,
  sessionKey: string,
) {
  return async (
    method: "chat.history" | "chat.startup" | "chat.message.get",
    params: Record<string, unknown> = {},
    options: Partial<
      Pick<
        GatewayRequestHandlerOptions,
        "client" | "acceptsSerializedJson" | "acceptsDeflatedSegments" | "params" | "req"
      >
    > = {},
  ) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      (method === "chat.message.get" ? chatMessageGetHandlers : chatHistoryHandlers)[method],
      "history handler",
    )({
      context,
      params: { sessionKey, ...params },
      req: { type: "req", id: "history-test", method },
      client: null,
      isWebchatConnect: () => false,
      respond,
      ...options,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    return respond;
  };
}

export function historyPayload(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond).toHaveBeenCalledTimes(1);
  const [ok, payload, error] = expectDefined(respond.mock.calls[0], "history response");
  expect(error).toBeUndefined();
  expect(ok).toBe(true);
  return expectDefined(asOptionalRecord(payload), "history payload");
}

export function expectHistoryPayload(
  respond: ReturnType<typeof vi.fn<RespondFn>>,
  payload: Record<string, unknown>,
) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.objectContaining(payload));
}

export function expectHistoryMessage(
  respond: ReturnType<typeof vi.fn<RespondFn>>,
  message: Record<string, unknown>,
) {
  expectHistoryPayload(respond, { ok: true, message: expect.objectContaining(message) });
}
