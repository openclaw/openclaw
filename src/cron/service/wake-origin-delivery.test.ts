import { describe, expect, it, vi } from "vitest";
import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { CronServiceState } from "./state.js";
import { wake } from "./wake.js";

const TOPIC_DELIVERY_CONTEXT: DeliveryContext = {
  channel: "telegram",
  to: "telegram:8661849123:topic:4052",
  accountId: "default",
  threadId: "4052",
};

function makeStateWithMocks(
  resolveOriginDeliveryContext?: (params: {
    sessionKey?: string;
    agentId?: string;
  }) => DeliveryContext | undefined,
): {
  state: CronServiceState;
  enqueueSessionEvent: ReturnType<typeof vi.fn>;
  resolveOriginDeliveryContext: ReturnType<typeof vi.fn>;
} {
  const enqueueSessionEvent = vi.fn();
  const resolveOrigin = vi.fn(resolveOriginDeliveryContext ?? (() => undefined));
  const state = {
    deps: {
      enqueueSessionEvent,
      resolveOriginDeliveryContext: resolveOrigin,
    },
  } as unknown as CronServiceState;
  return {
    state,
    enqueueSessionEvent,
    resolveOriginDeliveryContext: resolveOrigin,
  };
}

describe("cron wake() origin delivery-context carry", () => {
  it("preserves a captured origin route and target through delayed wake admission", () => {
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
      wake(state, {
        mode: "now",
        text: "finish the report",
        sessionKey: "agent:main:telegram:8661849123:topic:4052",
        agentId: "main",
        expectedTarget,
      }),
    ).toEqual({ ok: true });

    expect(resolveOriginDeliveryContext).not.toHaveBeenCalled();
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("finish the report", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
      deliveryContext: TOPIC_DELIVERY_CONTEXT,
      expectedTarget,
    });
  });

  it("threads the resolved deliveryContext onto a sessionKey-targeted wake", () => {
    const { state, enqueueSessionEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      () => TOPIC_DELIVERY_CONTEXT,
    );

    const result = wake(state, {
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
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
      deliveryContext: TOPIC_DELIVERY_CONTEXT,
    });
  });

  it("resolves and carries deliveryContext for a sessionKey-only wake (no agentId)", () => {
    // Pins the resolver guard against requiring both sessionKey and agentId.
    const { state, enqueueSessionEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      () => TOPIC_DELIVERY_CONTEXT,
    );

    const result = wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });
    expect(result).toEqual({ ok: true });

    expect(resolveOriginDeliveryContext).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: undefined,
    });
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      deliveryContext: TOPIC_DELIVERY_CONTEXT,
    });
  });

  it("omits deliveryContext when no origin context resolves (unchanged default routing)", () => {
    const { state, enqueueSessionEvent } = makeStateWithMocks(() => undefined);

    const result = wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });
    expect(result).toEqual({ ok: true });

    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });
    const [, options] = enqueueSessionEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).not.toHaveProperty("deliveryContext");
  });

  it("leaves untargeted owner resolution to ordinary session admission", () => {
    const { state, enqueueSessionEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      () => TOPIC_DELIVERY_CONTEXT,
    );

    const result = wake(state, { mode: "now", text: "no origin" });
    expect(result).toEqual({ ok: true });

    expect(resolveOriginDeliveryContext).not.toHaveBeenCalled();
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("no origin", undefined);
  });
});
