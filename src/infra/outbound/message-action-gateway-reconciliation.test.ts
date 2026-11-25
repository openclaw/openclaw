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
  expectRecordFields,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";
import type { OutboundMessageGatewayOptionsInput } from "./message-gateway-options.js";

function setupGatewayPlugin(
  blurb: string,
  handleAction: Parameters<typeof createGatewayActionPlugin>[0]["handleAction"] = vi.fn(async () =>
    jsonResult({ ok: true, local: true }),
  ),
) {
  setTestPlugin(
    createGatewayActionPlugin({
      pluginId: "gatewaychat",
      label: "Gateway Chat",
      blurb,
      actions: ["send"],
      messaging: { targetResolver: { looksLikeId: () => true } },
      handleAction,
    }),
    "gatewaychat",
  );
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    useActionHubPluginFixture();
    it("passes terminal reply correlation to gateway identity preflight", async () => {
      setupGatewayPlugin("Gateway Chat remote source reply test plugin.");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true, messageId: "gw-send-1" });
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => undefined);
      await runMessageAction({
        cfg: createEnabledMessageActionConfig("gatewaychat"),
        action: "send",
        params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });
      expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledWith({
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
      });
      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
    });

    it("rechecks current authority after identity preflight before Gateway dispatch", async () => {
      setupGatewayPlugin("Gateway Chat rejected handoff test plugin.");
      let actionCurrent = true;
      await expect(
        runMessageAction({
          cfg: createEnabledMessageActionConfig("gatewaychat"),
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: "message-call-1",
          gateway: {
            resolveAgentRuntimeIdentityToken: async () => {
              actionCurrent = false;
              return undefined;
            },
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          assertDirectAdapterHandoff: () => {
            if (!actionCurrent) {
              throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
            }
          },
          dryRun: false,
        }),
      ).rejects.toMatchObject({ name: "PlatformMessageNotDispatchedError" });
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });

    it("refuses dispatch when gateway identity preflight rejects", async () => {
      setupGatewayPlugin("Gateway Chat identity preflight test plugin.");
      const rejection = new Error("terminal source reply requires an active turn capability");
      await expect(
        runMessageAction({
          cfg: createEnabledMessageActionConfig("gatewaychat"),
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: "message-call-1",
          gateway: {
            resolveAgentRuntimeIdentityToken: async () => {
              throw rejection;
            },
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);
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
        setupGatewayPlugin("Gateway Chat timeout reconciliation test plugin.", handleActionResult);
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
        expectRecordFields(
          gatewayParams,
          {
            channel: "gatewaychat",
            action: "send",
            idempotencyKey: "idem-gateway-action",
          },
          "gateway call params",
        );
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
      setupGatewayPlugin("Gateway Chat cancellation test plugin.", handleActionResult);
      const controller = new AbortController();
      const timeout = Object.assign(new Error("gateway timeout after 30000ms"), {
        name: "GatewayTransportError",
        kind: "timeout",
        requestDispatched: true,
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
