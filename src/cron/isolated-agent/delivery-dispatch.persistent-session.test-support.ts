import { expect, it } from "vitest";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { makeBaseParams, makeResolvedDelivery } from "./delivery-dispatch.test-fixtures.js";

/** Reuses the delivery suite's isolated transport and transcript assertions. */
export function registerPersistentSessionDeliveryTests({
  commitBackgroundResultToSessionMock,
  deliverOutboundPayloads,
  appendAssistantMessageToSessionTranscript,
  expectDeliveryCall,
}: {
  commitBackgroundResultToSessionMock: unknown;
  deliverOutboundPayloads: unknown;
  appendAssistantMessageToSessionTranscript: unknown;
  expectDeliveryCall: (callIndex: number, expected: Record<string, unknown>) => void;
}) {
  it.each([false, true])(
    "publishes a persistent session final once with notification=%s",
    async (deliveryRequested) => {
      const params = makeBaseParams({
        deliveryRequested,
        sessionTarget: "session:agent:main:cron:test-job",
        synthesizedText: "The release approval is ready.",
      });
      params.job.delivery = { mode: deliveryRequested ? "announce" : "none" };
      params.deliveryPlan = resolveCronDeliveryPlan(params.job);
      params.resolvedDelivery = makeResolvedDelivery({
        sessionRoute: {
          ...makeResolvedDelivery().sessionRoute!,
          sessionKey: params.agentSessionKey,
        },
      });
      await dispatchCronDelivery(params);
      expect(commitBackgroundResultToSessionMock).toHaveBeenCalledOnce();
      expect(commitBackgroundResultToSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: params.agentSessionKey,
          text: "The release approval is ready.",
        }),
      );
      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(deliveryRequested ? 1 : 0);
    },
  );

  it("does not publish quiet or already visible error output for a persistent session", async () => {
    const params = makeBaseParams({
      deliveryRequested: false,
      sessionTarget: "session:agent:main:cron:test-job",
      synthesizedText: "Still waiting.",
    });
    params.job.delivery = { mode: "none" };
    params.deliveryPlan = resolveCronDeliveryPlan(params.job);
    params.skipDelivery = "silent";
    await dispatchCronDelivery(params);
    params.skipDelivery = undefined;
    params.undeliveredRunStatus = "error";
    await dispatchCronDelivery(params);
    expect(commitBackgroundResultToSessionMock).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "normalized execution destination",
      executionKey: "telegram:group:-100123:topic:42",
      destinationThread: "42",
      commits: 1,
    },
    {
      name: "different destination thread",
      executionKey: "agent:main:telegram:group:-100123:topic:42",
      destinationThread: "43",
      commits: 1,
    },
  ])(
    "publishes one settled transcript result for $name",
    async ({ executionKey, destinationThread, commits }) => {
      const params = makeBaseParams({
        synthesizedText: "Persistent session report",
        sessionTarget: `session:${executionKey}`,
      });
      params.agentSessionKey = executionKey;
      params.sourceSessionKey = "agent:main:telegram:group:-100123:topic:42";
      params.sourceSessionGeneration = {
        sessionId: "execution-session-id",
        lifecycleRevision: "execution-lifecycle-revision",
      };
      const destinationKey = `agent:main:telegram:group:-100123:topic:${destinationThread}`;
      params.resolvedDelivery = makeResolvedDelivery({
        to: "-100123",
        threadId: destinationThread,
        sessionRoute: {
          sessionKey: destinationKey,
          baseSessionKey: "agent:main:telegram:group:-100123",
          peer: { kind: "group", id: "-100123" },
          chatType: "group",
          from: "telegram:-100123",
          to: "-100123",
          threadId: destinationThread,
        },
      });

      expect(await dispatchCronDelivery(params)).toMatchObject({
        deliveryAttempted: true,
        delivered: true,
      });
      expect(deliverOutboundPayloads).toHaveBeenCalledOnce();
      expectDeliveryCall(0, {
        channel: "telegram",
        to: "-100123",
        threadId: destinationThread,
        payloads: [{ text: "Persistent session report" }],
      });
      expect(commitBackgroundResultToSessionMock).toHaveBeenCalledTimes(commits);
      if (commits) {
        expect(commitBackgroundResultToSessionMock).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: destinationKey,
            text: "Persistent session report",
          }),
        );
      }
      expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    },
  );
}
