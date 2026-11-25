import "./server-node-events.test-support.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  SessionEventOutcome,
  SessionEventReceipt,
} from "../auto-reply/reply/session-event-contract.js";
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
const cancelled: SessionEventOutcome = {
  status: "cancelled",
  executionStarted: false,
  delivered: false,
};

function receipt(id: string, settled: Promise<SessionEventOutcome>): SessionEventReceipt {
  return { id, cancel: () => true, accepted: Promise.resolve({ ok: true as const }), settled };
}

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

beforeEach(() => {
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
  // The real session queue, so replacement is checked by what stays pending, not by arguments.
  enqueue.mockReset().mockImplementation(realQueue.enqueueSystemEventEntry);
  handoff.mockClear();
  lookupSession.mockImplementation((key: string) => buildSessionLookup(key));
});

describe("notification updates of one key", () => {
  it("keep only the newest pending update of one phone's notification", async () => {
    const { notify } = phone("phone-a");
    for (const kb of [13, 26, 39]) {
      await notify({ text: `Received ${kb} KB` });
    }

    expect(peekSystemEvents(sessionKey)).toEqual([
      "Notification posted (node=phone-a key=ongoing): Received 39 KB",
    ]);
  });

  it("never replace another phone's pending update that shares the key", async () => {
    const a = phone("phone-a");
    const b = phone("phone-b");
    await a.notify({ text: "A 1" });
    await b.notify({ text: "B 1" });
    await a.notify({ text: "A 2" });

    expect(peekSystemEvents(sessionKey)).toEqual([
      "Notification posted (node=phone-b key=ongoing): B 1",
      "Notification posted (node=phone-a key=ongoing): A 2",
    ]);
  });

  it("keep a pending removal when a newer update of the key arrives", async () => {
    const { notify } = phone("phone-a");
    await notify({ text: "Received 13 KB" });
    await notify({ change: "removed" });
    await notify({ text: "Received 26 KB" });

    expect(peekSystemEvents(sessionKey)).toEqual([
      "Notification removed (node=phone-a key=ongoing)",
      "Notification posted (node=phone-a key=ongoing): Received 26 KB",
    ]);
  });

  it("do not report a superseded update as undelivered", async () => {
    const firstSettled = createDeferred<SessionEventOutcome>();
    handoff
      .mockImplementationOnce(() => receipt("receipt-1", firstSettled.promise))
      .mockImplementationOnce(() => receipt("receipt-2", new Promise(() => {})))
      .mockImplementationOnce(() => receipt("receipt-3", Promise.resolve(cancelled)));
    const { notify, warn } = phone("node-sup");
    await notify({ text: "Received 13 KB" });
    await notify({ text: "Received 26 KB" });
    firstSettled.resolve(cancelled);
    await notify({ key: "other", text: "Lost" });

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "notification event not delivered node=node-sup: cancelled",
      ),
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
