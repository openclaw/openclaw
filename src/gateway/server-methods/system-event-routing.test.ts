/** Targeted system-event routing and wake behavior. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  requestHeartbeat: vi.fn(),
}));

vi.mock("../../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/heartbeat-wake.js")>()),
  requestHeartbeat: mocks.requestHeartbeat,
}));

import { systemHandlers } from "./system.js";

describe("system-event routing", () => {
  afterEach(() => {
    resetSystemEventsForTest();
    mocks.requestHeartbeat.mockReset();
  });

  it("queues and immediately wakes the requested session", async () => {
    const respond = vi.fn();
    const sessionKey = "agent:main:main";
    const request = {
      params: {
        text: "OpenClaw updated. Welcome the user back.",
        sessionKey,
        wake: true,
      },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    )(request);

    expect(peekSystemEvents(sessionKey)).toEqual(["OpenClaw updated. Welcome the user back."]);
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey,
      heartbeat: { target: "last" },
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });
});
