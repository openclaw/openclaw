import { expect, it, type Mock } from "vitest";
import type { getChannelPlugin } from "../../channels/plugins/index.js";
import type { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import type {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { firstRespondCall } from "./send.test-helpers.js";
import type {
  createMessageMethodPluginFixtures,
  createMessageMethodTestDriver,
} from "./send.test-support.js";

type SessionRoutingTestHarness = Pick<
  ReturnType<typeof createMessageMethodTestDriver>,
  "runSend"
> & {
  mocks: {
    deliverOutboundPayloads: Mock<typeof deliverOutboundPayloads>;
    ensureOutboundSessionEntry: Mock<typeof ensureOutboundSessionEntry>;
    resolveOutboundSessionRoute: Mock<typeof resolveOutboundSessionRoute>;
    getChannelPlugin: Mock<typeof getChannelPlugin>;
  };
  mockDeliverySuccess: (messageId: string) => void;
  registerMessageThreadAddressingPlugin: ReturnType<
    typeof createMessageMethodPluginFixtures
  >["registerMessageThreadAddressingPlugin"];
};

export function registerSendSessionRoutingTests({
  mocks,
  runSend,
  mockDeliverySuccess,
  registerMessageThreadAddressingPlugin,
}: SessionRoutingTestHarness): void {
  const deliveryCall = () => mocks.deliverOutboundPayloads.mock.calls[0]?.[0];
  const ensureSessionEntryCall = () => mocks.ensureOutboundSessionEntry.mock.calls[0]?.[0];

  it.each([
    {
      name: "WebChat transcript",
      mirror: "agent:main:dashboard:send-mirror",
      destination: "agent:main:slack:channel:c1",
    },
    {
      name: "main transcript",
      mirror: "agent:main:main",
      destination: "agent:main:slack:channel:c1",
    },
    { name: "shared main destination", mirror: "agent:main:main", destination: "agent:main:main" },
  ])(
    "persists the destination route independently of the $name policy hint",
    async ({ mirror, destination }) => {
      mockDeliverySuccess("m-route-owner");
      mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
        sessionKey: destination,
        baseSessionKey: destination,
        peer: { kind: "channel", id: "c1" },
        chatType: "channel",
        from: "slack:channel:C1",
        to: "channel:C1",
      });

      const { respond } = await runSend({
        to: "channel:C1",
        message: "Requested external update",
        channel: "slack",
        sessionKey: mirror,
        idempotencyKey: "idem-route-owner",
      });

      expect(firstRespondCall(respond)[0]).toBe(true);
      expect(deliveryCall()?.session?.key).toBeUndefined();
      expect(deliveryCall()?.session?.policyKey).toBe(mirror);
      expect(ensureSessionEntryCall()?.route).toMatchObject({
        sessionKey: destination,
        baseSessionKey: destination,
        to: "channel:C1",
      });
    },
  );

  it("updates policy session keys and delivery thread ids when Slack routing derives a thread", async () => {
    registerMessageThreadAddressingPlugin("slack");
    mockDeliverySuccess("m-thread-derived");
    mocks.getChannelPlugin.mockReturnValueOnce(undefined);
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:slack:channel:c1:thread:1710000000.9999",
      baseSessionKey: "agent:main:slack:channel:c1",
      peer: { kind: "channel", id: "c1" },
      chatType: "channel",
      from: "slack:channel:C1",
      to: "channel:C1",
      threadId: "1710000000.9999",
    });

    await runSend({
      to: "channel:C1",
      message: "threaded",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1",
      idempotencyKey: "idem-thread-derived",
    });

    expect(ensureSessionEntryCall()?.route?.sessionKey).toBe(
      "agent:main:slack:channel:c1:thread:1710000000.9999",
    );
    expect(ensureSessionEntryCall()?.route?.baseSessionKey).toBe("agent:main:slack:channel:c1");
    expect(ensureSessionEntryCall()?.route?.threadId).toBe("1710000000.9999");
    expect(deliveryCall()?.threadId).toBe("1710000000.9999");
    expect(deliveryCall()?.session?.policyKey).toBe(
      "agent:main:slack:channel:c1:thread:1710000000.9999",
    );
  });

  it("preserves the provided session when Slack derives a thread for a different base session", async () => {
    registerMessageThreadAddressingPlugin("slack");
    mockDeliverySuccess("m-thread-mismatch");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:slack:channel:c2:thread:1710000000.9999",
      baseSessionKey: "agent:main:slack:channel:c2",
      peer: { kind: "channel", id: "c2" },
      chatType: "channel",
      from: "slack:channel:C2",
      to: "channel:C2",
      threadId: "1710000000.9999",
    });

    await runSend({
      to: "channel:C2",
      message: "threaded",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1",
      threadId: "1710000000.9999",
      idempotencyKey: "idem-thread-mismatch",
    });

    expect(deliveryCall()?.threadId).toBe("1710000000.9999");
    expect(deliveryCall()?.session?.key).toBeUndefined();
    expect(deliveryCall()?.session?.policyKey).toBe("agent:main:slack:channel:c1");
  });
}
