import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ErrorCodes,
  errorShape,
  validateConversationListParams,
  validateUiCommandParams,
  type ConversationListParams,
  type GatewayCoreRequestParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

describe("typed gateway method validation", () => {
  it("binds schema-derived payloads without losing the admitted request authority", async () => {
    expectTypeOf<
      GatewayCoreRequestParams["conversations.list"]
    >().toEqualTypeOf<ConversationListParams>();

    expectTypeOf(validateConversationListParams).toMatchTypeOf<
      Parameters<typeof defineValidatedGatewayMethod<"conversations.list">>[1]
    >();
    expectTypeOf(validateUiCommandParams).not.toMatchTypeOf<
      Parameters<typeof defineValidatedGatewayMethod<"conversations.list">>[1]
    >();

    const respond = vi.fn<RespondFn>();
    const handler = defineValidatedGatewayMethod(
      "conversations.list",
      validateConversationListParams,
      (request) => {
        const { params, respond: reply } = request;
        expectTypeOf(params).toEqualTypeOf<ConversationListParams>();
        expect(request).toBe(options);
        reply(true, { agentId: params.agentId, limit: params.limit });
      },
    );
    const options: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "typed-1", method: "conversations.list" },
      params: { agentId: "main", limit: 5 },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestContext,
    };

    await handler(options);

    expect(respond).toHaveBeenCalledWith(true, { agentId: "main", limit: 5 });
  });

  it("rejects malformed payloads before invoking the typed handler", async () => {
    const action = vi.fn();
    const respond = vi.fn<RespondFn>();
    const mapError = vi.fn(() => errorShape(ErrorCodes.UNAVAILABLE, "method failed"));
    const handler = defineValidatedGatewayMethod(
      "conversations.list",
      validateConversationListParams,
      action,
      mapError,
    );

    await handler({
      req: { type: "req", id: "typed-2", method: "conversations.list" },
      params: { agentId: "main", limit: "five" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestContext,
    });

    expect(action).not.toHaveBeenCalled();
    expect(mapError).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
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
    const respond = vi.fn<RespondFn>();
    const options: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "mapped-1", method: "conversations.list" },
      params: { agentId: "main" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestContext,
    };
    const handler = defineValidatedGatewayMethod(
      "conversations.list",
      validateConversationListParams,
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
    );

    await handler(options);

    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "method failed"),
    );
  });
});
