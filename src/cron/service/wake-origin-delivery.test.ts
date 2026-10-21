import { describe, expect, it, vi } from "vitest";
import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { wake } from "./wake.js";

const TOPIC_DELIVERY_CONTEXT: DeliveryContext = {
  channel: "telegram",
  to: "telegram:8661849123:topic:4052",
  accountId: "default",
  threadId: "4052",
};
const sessionKey = "agent:main:telegram:8661849123:topic:4052";

function makeStateWithMocks(
  resolveOriginDeliveryContext?: CronServiceDeps["resolveOriginDeliveryContext"],
) {
  const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
  const resolveOrigin = vi.fn(resolveOriginDeliveryContext ?? (() => undefined));
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: "unused-wake-origin-store",
    cronEnabled: true,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    enqueueSessionEvent,
    resolveOriginDeliveryContext: resolveOrigin,
  });
  return { state, enqueueSessionEvent, resolveOriginDeliveryContext: resolveOrigin };
}

describe("cron wake() origin delivery-context carry", () => {
  it("preserves a captured origin route and target through delayed wake admission", async () => {
    const { state, enqueueSessionEvent, resolveOriginDeliveryContext } = makeStateWithMocks(() => ({
      channel: "telegram",
      to: "telegram:other-chat",
    }));
    const expectedTarget: SessionEventTarget = {
      sessionId: "source-session",
      generation: "source-generation",
      deliveryContext: TOPIC_DELIVERY_CONTEXT,
    };

    expect(
      await wake(state, {
        mode: "now",
        text: "finish the report",
        sessionKey,
        agentId: "main",
        expectedTarget,
      }),
    ).toEqual({ ok: true });

    expect(resolveOriginDeliveryContext).not.toHaveBeenCalled();
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("finish the report", {
      sessionKey,
      agentId: "main",
      deliveryContext: TOPIC_DELIVERY_CONTEXT,
      expectedTarget,
    });
  });

  it.each([
    { agentId: "main", resolve: async () => TOPIC_DELIVERY_CONTEXT },
    { agentId: undefined, resolve: () => TOPIC_DELIVERY_CONTEXT },
  ])(
    "carries deliveryContext for a targeted wake (agentId=$agentId)",
    async ({ agentId, resolve }) => {
      const { state, enqueueSessionEvent, resolveOriginDeliveryContext } =
        makeStateWithMocks(resolve);
      const target = { sessionKey, ...(agentId ? { agentId } : {}) };
      const result = await wake(state, {
        mode: "now",
        text: "check the queue",
        ...target,
      });

      expect(result).toEqual({ ok: true });
      expect(resolveOriginDeliveryContext).toHaveBeenCalledExactlyOnceWith({ sessionKey, agentId });
      expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
        ...target,
        deliveryContext: TOPIC_DELIVERY_CONTEXT,
      });
    },
  );

  it("omits deliveryContext when no origin context resolves (unchanged default routing)", async () => {
    const { state, enqueueSessionEvent } = makeStateWithMocks(() => undefined);

    const result = await wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey,
    });
    expect(result).toEqual({ ok: true });

    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey,
    });
    const options = enqueueSessionEvent.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty("deliveryContext");
  });

  it("leaves untargeted owner resolution to ordinary session admission", async () => {
    const { state, enqueueSessionEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      () => TOPIC_DELIVERY_CONTEXT,
    );

    const result = await wake(state, { mode: "now", text: "no origin" });
    expect(result).toEqual({ ok: true });

    expect(resolveOriginDeliveryContext).not.toHaveBeenCalled();
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("no origin", {
      createIfMissing: undefined,
      assertAcceptanceCurrent: undefined,
    });
  });
});
