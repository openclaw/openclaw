import { beforeEach, describe, expect, it } from "vitest";
import { clearAllDispatchers, waitForSessionDispatchIdle } from "./dispatcher-registry.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

beforeEach(() => {
  clearAllDispatchers();
});

describe("waitForSessionDispatchIdle", () => {
  it("waits for pending replies on the same session", async () => {
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        await deliveryGate;
      },
    });
    dispatcher.bindSessionKey?.("main");
    expect(dispatcher.sendFinalReply({ text: "still delivering" })).toBe(true);
    dispatcher.markComplete();

    let settled = false;
    const waitPromise = waitForSessionDispatchIdle("main").then(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseDelivery();
    await waitPromise;
    expect(settled).toBe(true);
  });

  it("does not wait on dispatchers from other sessions", async () => {
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        await deliveryGate;
      },
    });
    dispatcher.bindSessionKey?.("other-session");
    expect(dispatcher.sendFinalReply({ text: "other session reply" })).toBe(true);
    dispatcher.markComplete();

    await expect(waitForSessionDispatchIdle("main")).resolves.toBeUndefined();

    releaseDelivery();
    await dispatcher.waitForIdle();
  });
});
