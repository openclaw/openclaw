import { expect, it, vi, type Mock } from "vitest";
import type { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { runWithOperatorToolGatewayAuthority } from "../operator-tool-gateway-authority.js";
import { assertGatewayUploadsEnabled } from "../upload-policy.js";
import { createMessageActionTurnClientForTests, firstRespondCall } from "./send.test-helpers.js";
import type { createMessageMethodTestDriver } from "./send.test-support.js";

type DeliveryAttemptTestHarness = Pick<
  ReturnType<typeof createMessageMethodTestDriver>,
  "invokeGatewayMessageMethod"
> & {
  mocks: {
    deliverOutboundPayloads: Mock<typeof deliverOutboundPayloads>;
    dispatchChannelMessageAction: Mock<typeof dispatchChannelMessageAction>;
    sendPoll: Mock<NonNullable<NonNullable<ChannelPlugin["outbound"]>["sendPoll"]>>;
  };
  mockDeliverySuccess: (messageId: string) => void;
};

export function registerSendDeliveryAttemptTests(harness: DeliveryAttemptTestHarness): void {
  const { mocks, invokeGatewayMessageMethod, mockDeliverySuccess } = harness;
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
          ? "authority is no longer active"
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
