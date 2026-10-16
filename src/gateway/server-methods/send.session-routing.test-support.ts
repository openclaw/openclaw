import { beforeAll, expect, it, vi, type Mock } from "vitest";
import type { getChannelPlugin } from "../../channels/plugins/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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

  function slackRoute(id = "c1", threadId?: string) {
    const baseSessionKey = `agent:main:slack:channel:${id}`;
    return {
      sessionKey: threadId ? `${baseSessionKey}:thread:${threadId}` : baseSessionKey,
      baseSessionKey,
      peer: { kind: "channel" as const, id },
      chatType: "channel" as const,
      from: `slack:channel:${id.toUpperCase()}`,
      to: `channel:${id.toUpperCase()}`,
      ...(threadId ? { threadId } : {}),
    };
  }

  it.each([false, true])(
    "persists a transcript mirror without rebinding its route (existing=%s)",
    async (existing) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const mirror = "agent:main:main";
        const destination = "agent:main:slack:channel:c1";
        mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(slackRoute());
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
        ).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text: "First contact" }],
            }),
          }),
        );
      });
    },
  );

  const deliveryCall = () => mocks.deliverOutboundPayloads.mock.calls[0]?.[0];
  const ensureSessionEntryCall = () => mocks.ensureOutboundSessionEntry.mock.calls[0]?.[0];

  const main = "agent:main:main",
    slack = "agent:main:slack:channel:c1";
  it.each([
    ["WebChat transcript", "agent:main:dashboard:send-mirror", slack],
    ["main transcript", main, slack],
    ["shared main destination", main, main],
  ])(
    "persists the destination route independently of the %s mirror",
    async (_name, mirror, destination) => {
      mockDeliverySuccess("m-route-owner");
      mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
        ...slackRoute(),
        sessionKey: destination,
        baseSessionKey: destination,
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
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(slackRoute("c1", "1710000000.9999"));

    await runSend({
      to: "channel:C1",
      message: "threaded",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1",
      idempotencyKey: "idem-thread-derived",
    });

    expect(ensureSessionEntryCall()?.route).toMatchObject({
      sessionKey: "agent:main:slack:channel:c1:thread:1710000000.9999",
      baseSessionKey: "agent:main:slack:channel:c1",
      threadId: "1710000000.9999",
    });
    expect(deliveryCall()).toMatchObject({
      threadId: "1710000000.9999",
      mirror: { sessionKey: "agent:main:slack:channel:c1:thread:1710000000.9999" },
    });
  });

  it("preserves the provided session when Slack derives a thread for a different base session", async () => {
    registerMessageThreadAddressingPlugin("slack");
    mockDeliverySuccess("m-thread-mismatch");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(slackRoute("c2", "1710000000.9999"));

    await runSend({
      to: "channel:C2",
      message: "threaded",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1",
      threadId: "1710000000.9999",
      idempotencyKey: "idem-thread-mismatch",
    });

    expect(deliveryCall()).toMatchObject({
      threadId: "1710000000.9999",
      session: { key: "agent:main:slack:channel:c1" },
      mirror: { sessionKey: "agent:main:slack:channel:c1" },
    });
  });
}
