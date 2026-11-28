import { expect, it, vi, type Mock } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { runWithOperatorToolGatewayAuthority } from "../operator-tool-gateway-authority.js";
import { assertGatewayUploadsEnabled } from "../upload-policy.js";
import { createMessageActionTurnClientForTests, firstRespondCall } from "./send.test-helpers.js";
import { makeContext, type createMessageMethodTestDriver } from "./send.test-support.js";

type DeliveryAttemptTestHarness = Pick<
  ReturnType<typeof createMessageMethodTestDriver>,
  "invokeGatewayMessageMethod" | "runSend"
> & {
  mocks: {
    deliverOutboundPayloads: Mock<typeof deliverOutboundPayloads>;
    ensureOutboundSessionEntry: Mock;
    dispatchChannelMessageAction: Mock<typeof dispatchChannelMessageAction>;
    sendPoll: Mock<NonNullable<NonNullable<ChannelPlugin["outbound"]>["sendPoll"]>>;
  };
  mockDeliverySuccess: (messageId: string) => void;
};

export function registerSendAttemptTests(
  mocks: DeliveryAttemptTestHarness["mocks"],
  invokeGatewayMessageMethod: DeliveryAttemptTestHarness["invokeGatewayMessageMethod"],
  mockDeliverySuccess: DeliveryAttemptTestHarness["mockDeliverySuccess"],
  runSend: DeliveryAttemptTestHarness["runSend"],
): void {
  it("returns and replays intentional send suppression without a delivery receipt", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(async (params) => {
      params.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
        hookEffect: { cancelReason: "private hook diagnostic" },
      });
      return [];
    });
    const context = makeContext();
    const first = await runSend({}, null, context);
    const replay = await runSend({}, null, context);
    const expected = {
      runId: "send-test",
      channel: "slack",
      deliveryStatus: "suppressed",
      suppressionReason: "cancelled_by_message_sending_hook",
    };
    const firstResponse = firstRespondCall(first.respond);
    expect(firstResponse.slice(0, 3)).toEqual([true, expected, undefined]);
    expect(firstResponse[3]?.channel).toBe("slack");
    const replayResponse = firstRespondCall(replay.respond);
    expect(replayResponse.slice(0, 3)).toEqual([true, expected, undefined]);
    expect(replayResponse[3]).toMatchObject({ cached: true });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
  });

  it.each(["missing", "identityless", "mixed"] as const)(
    "keeps %s delivery evidence from becoming intentional suppression",
    async (evidence) => {
      mocks.deliverOutboundPayloads.mockImplementationOnce(async (params) => {
        if (evidence !== "missing") {
          params.onPayloadDeliveryOutcome?.({
            index: 0,
            status: "suppressed",
            reason:
              evidence === "identityless"
                ? "adapter_returned_no_identity"
                : "cancelled_by_message_sending_hook",
          });
        }
        if (evidence === "mixed") {
          params.onPayloadDeliveryOutcome?.({
            index: 1,
            status: "suppressed",
            reason: "adapter_returned_no_identity",
          });
        }
        return [];
      });
      const { respond } = await runSend({});
      const response = firstRespondCall(respond);
      expect(response[0]).toBe(false);
      expect(response[1]).toBeUndefined();
      expect(response[2]).toMatchObject({
        code: ErrorCodes.UNAVAILABLE,
        message: "Error: No delivery result",
      });
      expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
    },
  );

  it.each(
    (["message.action", "send", "poll"] as const).flatMap((method) =>
      (["fence-failure", "delivery-authority", "upload-policy"] as const)
        .filter((failure) => method !== "poll" || failure !== "upload-policy")
        .map((failure) => ({ method, failure })),
    ),
  )("refuses cron $method on $failure at the fence or handoff", async ({ method, failure }) => {
    const sessionKey = "agent:main:slack:channel:C1";
    let deliveryCurrent = true;
    let uploadsEnabled = true;
    const beforeDeliveryAttempt = vi.fn(async () => {
      if (failure === "fence-failure") {
        throw new Error("occurrence delivery fence unavailable");
      }
      uploadsEnabled = failure !== "upload-policy";
    });
    const { client, context, close } = createMessageActionTurnClientForTests({
      sessionKey,
      runId: "scheduled-delivery-fence",
      deliveryAttempt: {
        beforeAttempt: beforeDeliveryAttempt,
        assertCurrent: () => {
          if (!deliveryCurrent) {
            throw new Error("occurrence delivery authority is no longer active");
          }
        },
      },
    });
    using _ = { [Symbol.dispose]: close };
    const platformSend = vi.fn();
    mockDeliverySuccess("unexpected-delivery");
    if (failure === "delivery-authority") {
      const adapter = {
        "message.action": mocks.dispatchChannelMessageAction,
        send: mocks.deliverOutboundPayloads,
        poll: mocks.sendPoll,
      }[method];
      adapter.mockImplementationOnce(
        async (params: { assertDirectAdapterHandoff?: () => void }) => {
          await Promise.resolve();
          deliveryCurrent = false;
          params.assertDirectAdapterHandoff?.();
          platformSend();
          throw new Error("Revoked authority reached the platform");
        },
      );
    }
    const respond = vi.fn();
    const message = { to: "C1", message: "report" };
    await runWithOperatorToolGatewayAuthority(
      {
        scopes: ["operator.write"],
        signal: new AbortController().signal,
        assertInputCommitAllowed: () =>
          assertGatewayUploadsEnabled({ gateway: { uploads: { enabled: uploadsEnabled } } }),
      },
      () =>
        invokeGatewayMessageMethod({
          method,
          client,
          context,
          respond,
          request: {
            channel: "slack",
            ...(method === "poll" ? {} : { sessionKey }),
            idempotencyKey: `scheduled-fence-${method}`,
            ...(method === "message.action"
              ? { action: "send", params: message }
              : method === "send"
                ? message
                : { to: "C1", question: "Ship?", options: ["Yes", "No"] }),
          },
        }),
    );
    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.message).toContain(
      failure === "fence-failure"
        ? "occurrence delivery fence unavailable"
        : failure === "delivery-authority"
          ? "The message turn has ended. Start a new turn to retry."
          : "uploads are disabled",
    );
    expect(beforeDeliveryAttempt).toHaveBeenCalledOnce();
    expect(platformSend).not.toHaveBeenCalled();
    if (failure !== "delivery-authority") {
      expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
      expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
      expect(mocks.sendPoll).not.toHaveBeenCalled();
    }
  });
}
