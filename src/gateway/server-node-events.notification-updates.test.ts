import "./server-node-events.test-support.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SessionEventOutcome } from "../auto-reply/reply/session-event-contract.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { handleNodeEvent } from "./server-node-events.js";

const { buildSessionLookup, buildNodeEventContext, runtimeMocks } =
  await import("./server-node-events.test-support.js");
const {
  enqueueSystemEventEntry: enqueue,
  enqueueSessionEventForHost: handoff,
  loadSessionEntry: lookupSession,
} = runtimeMocks;
const realQueue = await vi.importActual<typeof import("../infra/system-events.js")>(
  "../infra/system-events.js",
);

const sessionKey = "agent:ops:main";
const cancelled = { status: "cancelled", executionStarted: false, delivered: false } as const;

function phone(nodeId: string) {
  const warn = vi.fn();
  const ctx = buildNodeEventContext({ logGateway: { warn } });
  const notify = (payload: Record<string, unknown>) =>
    handleNodeEvent(ctx, nodeId, {
      event: "notifications.changed",
      payloadJSON: JSON.stringify({ change: "posted", key: "ongoing", ...payload }),
    });
  return { notify, warn };
}

function receipt(
  settled: Promise<SessionEventOutcome>,
  accepted: Promise<{ ok: true } | { ok: false; error: string; cause?: Error }> = Promise.resolve({
    ok: true,
  }),
) {
  return { id: "receipt", cancel: () => true, accepted, settled };
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
  // The real session queue, so replacement is checked by what stays pending.
  enqueue.mockReset().mockImplementation(realQueue.enqueueSystemEventEntry);
  handoff.mockClear();
  lookupSession.mockImplementation((key: string) => buildSessionLookup(key));
});

describe("posted notification updates", () => {
  it("keep only the newest pending update per phone and case-sensitive key", async () => {
    const a = phone("phone-a");
    const b = phone("phone-b");
    for (const kb of [13, 26, 39]) {
      await a.notify({ text: `Received ${kb} KB` });
    }
    await b.notify({ text: "B 1" });
    await a.notify({ key: "Alert", text: "Upper" });
    await a.notify({ key: "alert", text: "Lower" });

    expect(peekSystemEvents(sessionKey)).toEqual([
      "Notification posted (node=phone-a key=ongoing): Received 39 KB",
      "Notification posted (node=phone-b key=ongoing): B 1",
      "Notification posted (node=phone-a key=Alert): Upper",
      "Notification posted (node=phone-a key=alert): Lower",
    ]);
  });

  it("never replace a pending removal", async () => {
    const { notify } = phone("phone-a");
    await notify({ text: "Received 13 KB" });
    await notify({ change: "removed" });
    await notify({ text: "Received 26 KB" });

    expect(peekSystemEvents(sessionKey)).toEqual([
      "Notification removed (node=phone-a key=ongoing)",
      "Notification posted (node=phone-a key=ongoing): Received 26 KB",
    ]);
  });

  it("settle a replaced update quietly and still report other refusals", async () => {
    const firstAccepted = createDeferred<{ ok: false; error: string }>();
    const secondSettled = createDeferred<SessionEventOutcome>();
    handoff
      .mockImplementationOnce(() => receipt(new Promise(() => {}), firstAccepted.promise))
      .mockImplementationOnce(() => receipt(secondSettled.promise))
      .mockImplementationOnce(() => receipt(new Promise(() => {})))
      .mockImplementationOnce(() => receipt(Promise.resolve(cancelled)))
      .mockImplementationOnce(() =>
        receipt(
          new Promise(() => {}),
          Promise.resolve({ ok: false, error: "pairing changed", cause: new Error("pairing") }),
        ),
      );
    const { notify, warn } = phone("phone-a");
    const first = notify({ text: "Received 13 KB" });
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(1));
    await notify({ text: "Received 26 KB" });
    firstAccepted.resolve({ ok: false, error: "Session event was cancelled before acceptance" });
    await expect(first).resolves.toBeUndefined();

    await notify({ text: "Received 39 KB" });
    secondSettled.resolve(cancelled);
    await notify({ key: "other", text: "Lost" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith("notification event not delivered node=phone-a: cancelled");

    await expect(notify({ key: "third", text: "Refused" })).rejects.toThrow("pairing changed");
  });
});
