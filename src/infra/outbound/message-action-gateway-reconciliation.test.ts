// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
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
    it("owns terminal source-reply receipts before dispatching to a remote gateway", async () => {
      registerGatewayPlugin();
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
      registerGatewayPlugin();
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
      registerGatewayPlugin();
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

    it("cancels caller receipts after confirmed gateway request rejection", async () => {
      registerGatewayPlugin();
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const rejection = Object.assign(new Error("unsupported message action"), {
        name: "GatewayClientRequestError",
        gatewayCode: "FORBIDDEN",
        retryable: false,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);

      await expect(runTerminalSend()).rejects.toBe(rejection);
      expect(mocks.cancelTerminalSourceReplyDelivery).toHaveBeenCalledWith(receipt);
      expect(mocks.reconcileTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("cancels caller receipts after structured gateway startup rejection", async () => {
      registerGatewayPlugin();
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const rejection = Object.assign(new Error("gateway is still starting"), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        details: { method: "message.action", reason: "gateway-starting" },
        retryable: true,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);

      await expect(runTerminalSend()).rejects.toBe(rejection);
      expect(mocks.cancelTerminalSourceReplyDelivery).toHaveBeenCalledWith(receipt);
    });

    it("keeps caller receipts pending after unstructured provider unavailability", async () => {
      registerGatewayPlugin();
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const rejection = Object.assign(new Error("provider failed"), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        retryable: false,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);

      await expect(runTerminalSend()).rejects.toBe(rejection);
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("keeps caller receipts pending when reattach ends in a confirmed rejection", async () => {
      registerGatewayPlugin();
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
      registerGatewayPlugin();
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
      registerGatewayPlugin();
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

    it.each(["hosted"] as const)(
      "reattaches a timed-out %s send once with the original idempotency key",
      async (route) => {
        const request =
          route === "hosted"
            ? vi.fn<NonNullable<OutboundMessageGatewayOptionsInput["request"]>>()
            : mocks.callGatewayLeastPrivilege;
        const handleActionResult = vi.fn(async () => jsonResult({ ok: true, local: true }));
        registerGatewayPlugin(handleActionResult);
        const timeout =
          route === "hosted"
            ? new GatewayProtocolRequestTimeoutError({
                method: "message.action",
                timeoutMs: 30_000,
                requestSent: true,
              })
            : Object.assign(new Error("gateway timeout after 30000ms"), {
                name: "GatewayTransportError",
                kind: "timeout",
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
            ...(route === "hosted" ? { request } : {}),
          },
          dryRun: false,
        } satisfies Parameters<typeof runMessageAction>[0];
        const result = await runMessageAction({ ...actionInput, abortSignal: controller.signal });

        expect(request).toHaveBeenCalledTimes(2);
        if (route === "hosted") {
          expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
        }
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
      },
    );

    it("does not reconnect a timed-out gateway send after cancellation", async () => {
      const handleActionResult = vi.fn(async () => jsonResult({ ok: true, local: true }));
      registerGatewayPlugin(handleActionResult);
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
