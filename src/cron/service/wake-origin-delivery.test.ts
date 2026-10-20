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

function makeStateWithMocks(
  resolveOriginDeliveryContext?: CronServiceDeps["resolveOriginDeliveryContext"],
): {
  state: CronServiceState;
  enqueueSystemEvent: ReturnType<typeof vi.fn>;
  requestHeartbeat: ReturnType<typeof vi.fn>;
  resolveOriginDeliveryContext: ReturnType<typeof vi.fn>;
} {
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
  return {
    state,
    enqueueSystemEvent,
    requestHeartbeat,
    resolveOriginDeliveryContext: resolveOrigin,
  };
}

describe("cron wake() origin delivery-context carry", () => {
  it("threads the resolved deliveryContext onto a sessionKey-targeted wake", async () => {
    const { state, enqueueSystemEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      async () => TOPIC_DELIVERY_CONTEXT,
    );

    const result = await wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });

    expect(result).toEqual({ ok: true });
    expect(resolveOriginDeliveryContext).toHaveBeenCalledWith({
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
      deliveryContext: TOPIC_DELIVERY_CONTEXT,
    });
  });

  it("resolves and carries deliveryContext for a sessionKey-only wake (no agentId)", async () => {
    // Pins the resolver guard against requiring both sessionKey and agentId.
    const { state, enqueueSystemEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      () => TOPIC_DELIVERY_CONTEXT,
    );

    await wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });

    expect(resolveOriginDeliveryContext).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: undefined,
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      deliveryContext: TOPIC_DELIVERY_CONTEXT,
    });
  });

  it("omits deliveryContext when no origin context resolves (unchanged default routing)", async () => {
    const { state, enqueueSystemEvent } = makeStateWithMocks(() => undefined);

    await wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });

    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
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
