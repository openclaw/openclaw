import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProtocolRequestTimeoutError } from "../../../packages/gateway-client/src/protocol-request.js";
import { jsonResult } from "../../agents/tools/common.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
  useActionHubPluginFixture,
  readMockCallArg,
  readRecordField,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";
import type { OutboundMessageGatewayOptionsInput } from "./message-gateway-options.js";

const receipt = {
  sessionId: "session-1",
  sessionKey: "agent:main:gatewaychat:direct:user-123",
  sourceTurnId: "source-turn-1",
  storePath: "/tmp/sessions.json",
  toolCallId: "message-call-1",
};

function registerGatewayPlugin(
  handleAction = vi.fn(async () => jsonResult({ ok: true, local: true })),
) {
  setTestPlugin(
    createGatewayActionPlugin({
      pluginId: "gatewaychat",
      label: "Gateway Chat",
      blurb: "Gateway reconciliation test plugin.",
      actions: ["send"],
      messaging: { targetResolver: { looksLikeId: () => true } },
      handleAction,
    }),
    "gatewaychat",
  );
}

type ActionInput = Parameters<typeof runMessageAction>[0];
function runTerminalSend(
  input: Omit<Partial<ActionInput>, "gateway"> & {
    gateway?: Partial<NonNullable<ActionInput["gateway"]>>;
  } = {},
) {
  return runMessageAction({
    cfg: createEnabledMessageActionConfig("gatewaychat"),
    action: "send",
    params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
    sourceReplyFinal: true,
    sourceReplyToolCallId: receipt.toolCallId,
    dryRun: false,
    ...input,
    gateway: {
      terminalSourceReplyReceiptOwner: "caller",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      ...input.gateway,
    },
  });
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    useActionHubPluginFixture();
    const handleActionResult = vi.fn(async () => jsonResult({ ok: true, local: true }));
    beforeEach(() => {
      handleActionResult.mockClear();
      registerGatewayPlugin(handleActionResult);
    });
    it("owns terminal source-reply receipts before dispatching to a remote gateway", async () => {
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      mocks.reconcileTerminalSourceReplyDelivery.mockResolvedValue("delivered");
      const deliveredPayload = { ok: true, messageId: "gw-send-1" };
      mocks.callGatewayLeastPrivilege.mockResolvedValue(deliveredPayload);
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => undefined);
      const policySessionKey = "agent:main:gatewaychat:policy:user-123";

      await runTerminalSend({
        messageActionAuthorization: {
          toolContext: {
            currentChannelProvider: "gatewaychat",
            currentChannelId: "user-123",
            currentSourceTurnId: "source-turn-1",
          },
        },
        sourceReplyDeliveryMode: "message_tool_only",
        sessionKey: policySessionKey,
        sourceReplySessionKey: receipt.sessionKey,
        sessionId: receipt.sessionId,
        agentId: "main",
        gateway: { resolveAgentRuntimeIdentityToken },
      });

      expect(mocks.beginTerminalSourceReplyDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "send",
          channel: "gatewaychat",
          idempotencyKey: "idem-gateway-action",
          sessionId: receipt.sessionId,
          sessionKey: receipt.sessionKey,
          sourceReplyFinal: true,
          toolCallId: receipt.toolCallId,
          toolContext: expect.objectContaining({ currentSourceTurnId: "source-turn-1" }),
        }),
      );
      expect(mocks.beginTerminalSourceReplyDelivery.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.callGatewayLeastPrivilege.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledWith({
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
      });
      expect(mocks.reconcileTerminalSourceReplyDelivery).toHaveBeenCalledWith({
        deliveredPayload,
        mirror: expect.objectContaining({
          idempotencyKey: "idem-gateway-action",
          sourceReplyFinal: true,
          toolCallId: "message-call-1",
        }),
        receipt,
      });
    });

    it("returns an ambiguous terminal outcome without remote provider I/O", async () => {
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue({
        outcome: "delivery_ambiguous",
        result: {
          status: "delivery_ambiguous",
          delivered: false,
          message: "The completed reply may already have been delivered. Do not retry it.",
        },
      });

      const result = await runTerminalSend();

      expect(result).toMatchObject({
        payload: {
          status: "delivery_ambiguous",
          delivered: false,
        },
      });
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });

    it("cancels caller receipts when the final local handoff rejects before Gateway dispatch", async () => {
      let actionCurrent = true;
      mocks.beginTerminalSourceReplyDelivery.mockImplementation(async () => {
        actionCurrent = false;
        return receipt;
      });

      await expect(
        runTerminalSend({
          assertDirectAdapterHandoff: () => {
            if (!actionCurrent) {
              throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
            }
          },
        }),
      ).rejects.toMatchObject({ name: "PlatformMessageNotDispatchedError" });
      expect(mocks.cancelTerminalSourceReplyDelivery).toHaveBeenCalledWith(receipt);
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
      expect(mocks.reconcileTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "confirmed request rejection",
        message: "unsupported message action",
        code: "FORBIDDEN",
        retryable: false,
        cancel: true,
      },
      {
        name: "structured startup rejection",
        message: "gateway is still starting",
        code: "UNAVAILABLE",
        details: { method: "message.action", reason: "gateway-starting" },
        retryable: true,
        cancel: true,
      },
      {
        name: "unstructured provider unavailability",
        message: "provider failed",
        code: "UNAVAILABLE",
        retryable: false,
        cancel: false,
      },
    ])(
      "settles the caller receipt after $name",
      async ({ message, code, details, retryable, cancel }) => {
        mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
        const rejection = Object.assign(new Error(message), {
          name: "GatewayClientRequestError",
          gatewayCode: code,
          retryable,
          ...(details ? { details } : {}),
        });
        mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);
        await expect(runTerminalSend()).rejects.toBe(rejection);
        if (cancel) {
          expect(mocks.cancelTerminalSourceReplyDelivery).toHaveBeenCalledWith(receipt);
        } else {
          expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
        }
        expect(mocks.reconcileTerminalSourceReplyDelivery).not.toHaveBeenCalled();
      },
    );

    it("keeps caller receipts pending when reattach ends in a confirmed rejection", async () => {
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const timeout = Object.assign(new Error("gateway timeout"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      const rejection = Object.assign(new Error("gateway is still starting"), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        details: { method: "message.action", reason: "gateway-starting" },
        retryable: true,
      });
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockRejectedValueOnce(rejection);

      await expect(runTerminalSend()).rejects.toBe(rejection);

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
      expect(mocks.reconcileTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("preserves caller receipts when reattach returns an explicit failure", async () => {
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const timeout = Object.assign(new Error("gateway timeout"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      const failedPayload = { ok: false, status: "failed" };
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce(failedPayload);

      await runTerminalSend();

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(mocks.reconcileTerminalSourceReplyDelivery).toHaveBeenCalledWith({
        deliveredPayload: failedPayload,
        mirror: expect.objectContaining({ toolCallId: receipt.toolCallId }),
        preservePendingOnExplicitFailure: true,
        receipt,
      });
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("runs terminal gateway identity preflight before arming the caller receipt", async () => {
      const rejection = new Error("terminal source reply requires an active turn capability");
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => {
        throw rejection;
      });

      await expect(
        runTerminalSend({
          gateway: { resolveAgentRuntimeIdentityToken },
        }),
      ).rejects.toBe(rejection);
      expect(mocks.beginTerminalSourceReplyDelivery).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });

    it("reattaches a timed-out hosted send once with the original idempotency key", async () => {
      const request = vi.fn<NonNullable<OutboundMessageGatewayOptionsInput["request"]>>();
      const timeout = new GatewayProtocolRequestTimeoutError({
        method: "message.action",
        timeoutMs: 30_000,
        requestSent: true,
      });
      request
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce({ ok: true, messageId: "gw-send-late" });
      const controller = new AbortController();

      const actionInput = {
        cfg: createEnabledMessageActionConfig("gatewaychat"),
        action: "send",
        params: {
          channel: "gatewaychat",
          target: "user-123",
          message: "hello from agent",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
          timeoutMs: 120_000,
          request,
        },
        dryRun: false,
      } satisfies Parameters<typeof runMessageAction>[0];
      const result = await runMessageAction({ ...actionInput, abortSignal: controller.signal });

      expect(request).toHaveBeenCalledTimes(2);
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
      const firstCall = readMockCallArg(request, "first gateway least privilege call");
      const secondCall = readMockCallArg(request, "second gateway least privilege call", 1);
      expect(firstCall.timeoutMs).toBe(30_000);
      expect(secondCall).toMatchObject({
        ...firstCall,
        timeoutMs: null,
        signal: expect.any(AbortSignal),
      });
      expect(secondCall.signal).toBeInstanceOf(AbortSignal);
      expect(secondCall.signal).not.toBe(firstCall.signal);
      const gatewayParams = readRecordField(firstCall, "params", "gateway call params");
      expect(gatewayParams).toMatchObject({
        channel: "gatewaychat",
        action: "send",
        idempotencyKey: "idem-gateway-action",
      });
      expect(handleActionResult).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        kind: "send",
        channel: "gatewaychat",
        action: "send",
        handledBy: "plugin",
        payload: { ok: true, messageId: "gw-send-late" },
      });

      request.mockReset();
      request
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce({ ok: true, messageId: "gw-send-bounded" });

      const boundedResult = await runMessageAction(actionInput);

      expect(request).toHaveBeenCalledTimes(2);
      const boundedReconciliationCall = readMockCallArg(
        request,
        "bounded gateway reconciliation call",
        1,
      );
      expect(boundedReconciliationCall).toMatchObject({ timeoutMs: 60_000, signal: undefined });
      const boundedParams = readRecordField(
        boundedReconciliationCall,
        "params",
        "bounded gateway reconciliation params",
      );
      expect(boundedParams.idempotencyKey).toBe("idem-gateway-action");
      expect(boundedResult).toMatchObject({
        kind: "send",
        payload: { ok: true, messageId: "gw-send-bounded" },
      });
    });

    it("does not reconnect a timed-out gateway send after cancellation", async () => {
      const controller = new AbortController();
      const timeout = Object.assign(new Error("gateway timeout after 30000ms"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockImplementationOnce(async (call: { signal?: AbortSignal }) => {
          controller.abort();
          expect(call.signal?.aborted).toBe(true);
          throw Object.assign(new Error("gateway request aborted"), { name: "AbortError" });
        });

      await expect(
        runMessageAction({
          cfg: createEnabledMessageActionConfig("gatewaychat"),
          action: "send",
          params: {
            channel: "gatewaychat",
            target: "user-123",
            message: "hello from agent",
          },
          gateway: {
            clientName: "cli",
            mode: "cli",
          },
          abortSignal: controller.signal,
          dryRun: false,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(handleActionResult).not.toHaveBeenCalled();
    });
  });
});
