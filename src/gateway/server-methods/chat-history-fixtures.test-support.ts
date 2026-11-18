import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi, type Mock } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export async function seedHistorySession(
  id: string,
  entry: Parameters<typeof upsertSessionEntryCore>[1] = {},
) {
  const scope = { agentId: "main", sessionKey: `agent:main:${id}`, sessionId: id };
  await upsertSessionEntryCore(scope, { sessionId: id, updatedAt: 1, ...entry });
  return scope;
}

export function expectHistorySuccess(respond: Mock<RespondFn>) {
  expect(respond).toHaveBeenCalledTimes(1);
  const call = expectDefined(respond.mock.calls[0], "history response");
  expect(call).toEqual([true, expect.anything()]);
  return expectDefined(asOptionalRecord(call[1]), "history payload");
}

export function expectHistoryFailure(respond: Mock<RespondFn>, code: string, retryable?: boolean) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({ code, ...(retryable ? { retryable } : {}) }),
  );
}

export async function requestHistory(
  method: string,
  params: Record<string, unknown>,
  context: GatewayRequestContext,
  client: GatewayRequestHandlerOptions["client"] = null,
  respond = vi.fn<RespondFn>(),
  isWebchatConnect = false,
  signal?: AbortSignal,
) {
  await expectDefined(
    { ...chatHistoryHandlers, ...chatMessageGetHandlers }[method],
    "chat handler",
  )({
    params,
    context,
    client,
    respond,
    signal,
    req: { type: "req", id: "history-test", method },
    isWebchatConnect: () => isWebchatConnect,
  });
  return respond;
}
