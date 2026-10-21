import { describe, expect, it, vi } from "vitest";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { CronServiceDeps, CronServiceState } from "./state.js";
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
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const resolveOrigin = vi.fn(resolveOriginDeliveryContext ?? (() => undefined));
  const state = {
    deps: {
      enqueueSystemEvent,
      requestHeartbeat,
      resolveOriginDeliveryContext: resolveOrigin,
    },
  } as unknown as CronServiceState;
  return { state, enqueueSystemEvent, resolveOriginDeliveryContext: resolveOrigin };
}

describe("cron wake() origin delivery-context carry", () => {
  it.each([
    { agentId: "main", resolve: async () => TOPIC_DELIVERY_CONTEXT },
    { agentId: undefined, resolve: () => TOPIC_DELIVERY_CONTEXT },
  ])(
    "carries deliveryContext for a targeted wake (agentId=$agentId)",
    async ({ agentId, resolve }) => {
      const { state, enqueueSystemEvent, resolveOriginDeliveryContext } =
        makeStateWithMocks(resolve);
      const target = { sessionKey, ...(agentId ? { agentId } : {}) };
      const result = await wake(state, {
        mode: "now",
        text: "check the queue",
        ...target,
      });

      expect(result).toEqual({ ok: true });
      expect(resolveOriginDeliveryContext).toHaveBeenCalledExactlyOnceWith({ sessionKey, agentId });
      expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
        ...target,
        deliveryContext: TOPIC_DELIVERY_CONTEXT,
      });
    },
  );

  it("omits deliveryContext when no origin context resolves (unchanged default routing)", async () => {
    const { state, enqueueSystemEvent } = makeStateWithMocks(() => undefined);

    await wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey,
    });

    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey,
    });
    const [, options] = enqueueSystemEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).not.toHaveProperty("deliveryContext");
  });

  it("keeps the no-origin call shape (enqueueSystemEvent(text, undefined)) when untargeted", async () => {
    const { state, enqueueSystemEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      () => TOPIC_DELIVERY_CONTEXT,
    );

    await wake(state, { mode: "now", text: "no origin" });

    expect(resolveOriginDeliveryContext).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("no origin", undefined);
  });
});
