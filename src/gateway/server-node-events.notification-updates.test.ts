import "./server-node-events.test-support.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  SessionEventOutcome,
  SessionEventReceipt,
} from "../auto-reply/reply/session-event-contract.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { handleNodeEvent } from "./server-node-events.js";

const { buildSessionLookup, buildNodeEventContext, runtimeMocks } =
  await import("./server-node-events.test-support.js");
const {
  enqueueSystemEventEntry: enqueue,
  enqueueSessionEventForHost: handoff,
  loadSessionEntry: lookupSession,
} = runtimeMocks;

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
  enqueue.mockReset().mockImplementation((text: string) => ({ id: "node-event", text }));
  handoff.mockClear();
  lookupSession.mockImplementation((sessionKey: string) => buildSessionLookup(sessionKey));
});

describe("notification updates of one key", () => {
  it("replace the pending posted update, and leave removals appended", async () => {
    const { notify } = phone("node");
    await notify({ text: "Received 13 KB" });
    await notify({ change: "removed" });

    expect(enqueue.mock.calls.map(([, options]) => options.replace)).toEqual([true, undefined]);
  });

  it("do not report a superseded update as undelivered", async () => {
    const firstSettled = createDeferred<SessionEventOutcome>();
    enqueue
      .mockReturnValueOnce({ id: "update-1" })
      .mockReturnValueOnce({ id: "update-2" })
      .mockReturnValueOnce({ id: "other-1" });
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
