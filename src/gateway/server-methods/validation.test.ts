import { expect, expectTypeOf, it, vi } from "vitest";
import {
  ErrorCodes,
  errorShape,
  validateConversationListParams as validateList,
  validateUiCommandParams,
  type ConversationListParams,
  type GatewayCoreRequestParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type ListValidator = Parameters<typeof defineValidatedGatewayMethod<"conversations.list">>[1];

function createRequest(params: Record<string, unknown>): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "validation", method: "conversations.list" },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn<RespondFn>(),
    context: {} as GatewayRequestContext,
  };
}

it("binds schema-derived payloads without losing the admitted request authority", async () => {
  expectTypeOf<
    GatewayCoreRequestParams["conversations.list"]
  >().toEqualTypeOf<ConversationListParams>();

  expectTypeOf(validateList).toMatchTypeOf<ListValidator>();
  expectTypeOf(validateUiCommandParams).not.toMatchTypeOf<ListValidator>();

  const options = createRequest({ agentId: "main", limit: 5 });
  await defineValidatedGatewayMethod("conversations.list", validateList, (request) => {
    const { params, respond: reply } = request;
    expectTypeOf(params).toEqualTypeOf<ConversationListParams>();
    expect(request).toBe(options);
    reply(true, { agentId: params.agentId, limit: params.limit });
  })(options);
  expect(options.respond).toHaveBeenCalledWith(true, { agentId: "main", limit: 5 });
});

it("rejects malformed payloads before invoking the typed handler", async () => {
  const action = vi.fn();
  const options = createRequest({ agentId: "main", limit: "five" });
  const mapError = vi.fn(() => errorShape(ErrorCodes.UNAVAILABLE, "method failed"));
  await defineValidatedGatewayMethod("conversations.list", validateList, action, mapError)(options);
  expect(action).not.toHaveBeenCalled();
  expect(mapError).not.toHaveBeenCalled();
  expect(options.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("invalid conversations.list params"),
    }),
  );
});

it.each([false, true])("maps handler failures after validation (async: %s)", async (async) => {
  const failure = new Error("method failed");
  const options = createRequest({ agentId: "main" });
  await defineValidatedGatewayMethod(
    "conversations.list",
    validateList,
    (request) => {
      expect(request).toBe(options);
      if (async) {
        return Promise.reject(failure);
      }
      throw failure;
    },
    (error) => {
      expect(error).toBe(failure);
      return errorShape(ErrorCodes.UNAVAILABLE, failure.message);
    },
  )(options);

  expect(options.respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, "method failed"),
  );
});
