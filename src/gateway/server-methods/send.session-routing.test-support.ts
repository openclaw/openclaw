import { expect, it, vi, type Mock } from "vitest";
import type { getChannelPlugin } from "../../channels/plugins/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { mirrorDeliveredPayloads } from "../../infra/outbound/deliver-transcript.js";
import type { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import type * as Outbound from "../../infra/outbound/outbound-session.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { firstRespondCall } from "./send.test-helpers.js";
import type { MessageMethodDriver, MessageMethodPlugins } from "./send.test-support.js";

type SessionRoutingTestHarness = Pick<MessageMethodDriver, "runSend"> &
  Pick<MessageMethodPlugins, "registerMessageThreadAddressingPlugin"> & {
    mocks: {
      deliverOutboundPayloads: Mock<typeof deliverOutboundPayloads>;
      ensureOutboundSessionEntry: Mock<typeof Outbound.ensureOutboundSessionEntry>;
      resolveOutboundSessionRoute: Mock<typeof Outbound.resolveOutboundSessionRoute>;
      getChannelPlugin: Mock<typeof getChannelPlugin>;
    };
    mockDeliverySuccess: (messageId: string) => void;
  };

export function registerSendSessionRoutingTests({
  mocks,
  runSend,
  mockDeliverySuccess,
  registerMessageThreadAddressingPlugin,
}: SessionRoutingTestHarness): void {
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
  const main = "agent:main:main",
    slack = "agent:main:slack:channel:c1";
  const send = (params: Parameters<typeof runSend>[0] = {}) =>
    runSend({
      to: "channel:C1",
      message: "First contact",
      channel: "slack",
      sessionKey: slack,
      idempotencyKey: "route",
      ...params,
    });

  it.each([false, true])(
    "persists a transcript mirror without rebinding its route (existing=%s)",
    async (existing) =>
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(slackRoute());
        const { ensureOutboundSessionEntry } = await vi.importActual<typeof Outbound>(
          "../../infra/outbound/outbound-session.js",
        );
        mocks.ensureOutboundSessionEntry.mockImplementationOnce(ensureOutboundSessionEntry);
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
          await sessions.replaceSessionEntry(
            { sessionKey: main },
            { sessionId: "existing-mirror", updatedAt: 1, delivery: savedDelivery },
          );
        } else {
          expect(sessions.loadSessionEntry({ sessionKey: main })).toBeUndefined();
        }
        const { respond } = await send({ sessionKey: main });
        expect(firstRespondCall(respond)[0]).toBe(true);
        const entry = sessions.loadSessionEntry({ sessionKey: main });
        expect(entry?.sessionId).toEqual(existing ? "existing-mirror" : expect.any(String));
        if (existing) {
          expect(entry?.delivery).toEqual(savedDelivery);
        } else {
          expect(entry?.delivery?.kind).not.toBe("external");
        }
        expect(sessions.loadSessionEntry({ sessionKey: slack })?.delivery).toMatchObject({
          kind: "external",
          context: { channel: "slack", to: "channel:C1" },
        });
        expect(
          await sessions.loadTranscriptEvents({
            agentId: "main",
            sessionKey: main,
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
      }),
  );

  const deliveryCall = () => mocks.deliverOutboundPayloads.mock.calls[0]?.[0];
  const ensureSessionEntryCall = () => mocks.ensureOutboundSessionEntry.mock.calls[0]?.[0];

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

      const { respond } = await send({ sessionKey: mirror });

      expect(firstRespondCall(respond)[0]).toBe(true);
      expect(deliveryCall()).toMatchObject({
        mirror: { sessionKey: mirror },
        session: { key: mirror },
      });
      expect(ensureSessionEntryCall()?.route).toMatchObject({
        sessionKey: destination,
        baseSessionKey: destination,
        to: "channel:C1",
      });
    },
  );

  it.each(["c1", "c2"])(
    "binds derived Slack threads only to their matching base (%s)",
    async (id) => {
      registerMessageThreadAddressingPlugin("slack");
      mockDeliverySuccess("m-thread");
      const threadId = "1710000000.9999";
      if (id === "c1") {
        mocks.getChannelPlugin.mockReturnValueOnce(undefined);
      }
      mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(slackRoute(id, threadId));
      await send({ to: `channel:${id.toUpperCase()}`, ...(id === "c2" ? { threadId } : {}) });
      if (id === "c1") {
        expect(ensureSessionEntryCall()?.route).toMatchObject({
          sessionKey: `${slack}:thread:${threadId}`,
          baseSessionKey: slack,
          threadId,
        });
      }
      const mirror = id === "c1" ? `${slack}:thread:${threadId}` : slack;
      expect(deliveryCall()).toMatchObject({
        threadId,
        mirror: { sessionKey: mirror },
        ...(id === "c2" ? { session: { key: slack } } : {}),
      });
    },
  );
}
