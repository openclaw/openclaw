import { beforeAll, expect, it, vi, type Mock } from "vitest";
import type { getChannelPlugin } from "../../channels/plugins/index.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { mirrorDeliveredPayloads } from "../../infra/outbound/deliver-transcript.js";
import type { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import type {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
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
  let persistRoute: typeof ensureOutboundSessionEntry;
  beforeAll(async () => {
    ({ ensureOutboundSessionEntry: persistRoute } = await vi.importActual<
      typeof import("../../infra/outbound/outbound-session.js")
    >("../../infra/outbound/outbound-session.js"));
  });

  it.each([false, true])(
    "persists a transcript mirror without rebinding its route (existing=%s)",
    async (existing) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const mirror = "agent:main:main";
        const destination = "agent:main:slack:channel:c1";
        mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
          sessionKey: destination,
          baseSessionKey: destination,
          peer: { kind: "channel", id: "c1" },
          chatType: "channel",
          from: "slack:channel:C1",
          to: "channel:C1",
        });
        mocks.ensureOutboundSessionEntry.mockImplementationOnce(persistRoute);
        mocks.deliverOutboundPayloads.mockImplementationOnce(async (delivery) => {
          const result = { channel: "slack" as const, messageId: "first-contact" };
          await delivery.onDeliveryResult?.(result);
          await mirrorDeliveredPayloads({
            delivery,
            payloads: [{ text: "First contact", mediaUrls: [] }],
          });
          return [result];
        });
        const savedDelivery = normalizeSessionDeliveryState({
          context: { channel: "telegram", to: "saved-room", accountId: "saved-bot" },
        });
        if (existing) {
          await replaceSessionEntry(
            { sessionKey: mirror },
            { sessionId: "existing-mirror", updatedAt: 1, delivery: savedDelivery },
          );
        } else {
          expect(loadSessionEntry({ sessionKey: mirror })).toBeUndefined();
        }
        const { respond } = await runSend({
          to: "channel:C1",
          message: "First contact",
          channel: "slack",
          sessionKey: mirror,
          idempotencyKey: "first-contact-mirror",
        });
        expect(firstRespondCall(respond)[0]).toBe(true);
        const entry = loadSessionEntry({ sessionKey: mirror });
        expect(entry?.sessionId).toBeDefined();
        if (existing) {
          expect(entry?.sessionId).toBe("existing-mirror");
          expect(entry?.delivery).toEqual(savedDelivery);
        } else {
          expect(entry?.delivery?.kind).not.toBe("external");
        }
        expect(loadSessionEntry({ sessionKey: destination })?.delivery).toMatchObject({
          kind: "external",
          context: { channel: "slack", to: "channel:C1" },
        });
        expect(
          await loadTranscriptEvents({
            agentId: "main",
            sessionKey: mirror,
            sessionId: entry!.sessionId,
          }),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                role: "assistant",
                content: [{ type: "text", text: "First contact" }],
              }),
            }),
          ]),
        );
      });
    },
  );

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
    "persists the destination route independently of the $name mirror",
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
      expect(deliveryCall()?.mirror?.sessionKey).toBe(mirror);
      expect(deliveryCall()?.session?.key).toBe(mirror);
      expect(ensureSessionEntryCall()?.route).toMatchObject({
        sessionKey: destination,
        baseSessionKey: destination,
        to: "channel:C1",
      });
    },
  );

  it("updates mirror session keys and delivery thread ids when Slack routing derives a thread", async () => {
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
    expect(deliveryCall()?.mirror?.sessionKey).toBe(
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
    expect(deliveryCall()?.session?.key).toBe("agent:main:slack:channel:c1");
    expect(deliveryCall()?.mirror?.sessionKey).toBe("agent:main:slack:channel:c1");
  });
}
