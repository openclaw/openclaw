import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  beginGatewayRestartSignalAdmission,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { create, identity, type EntryRow } from "./session-row-projection-record.js";
import * as transcript from "./session-row-transcript-backfill.js";

beforeEach(resetGatewayWorkAdmission);
afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});
function rows() {
  return ["one", "two"].map((key): EntryRow =>
    Object.assign(
      create({ key, agentId: "main", storeTarget: { agentId: "main", storePath: "unused" } }),
      { entry: { sessionId: key, updatedAt: 1 } },
    ),
  );
}
it.for(["stop", "restart", "reset"] as const)(
  "retires queued rows and late publications on %s",
  async (mode, { signal }) => {
    const pending = createDeferredCore<{ lastMessagePreview: string }>();
    const admitted = createDeferredCore();
    const read = vi
      .spyOn(transcript, "backfillSessionRowTranscriptFields")
      .mockImplementationOnce(() => {
        admitted.resolve();
        return pending.promise;
      })
      .mockResolvedValue({ lastMessagePreview: "should not publish" });
    const backlog = rows();
    const publish = vi.fn();
    const owner = createSessionRowProjectionBackfill({
      ready: async () => {},
      read: (id) => backlog.find((row) => identity(row) === id),
      current: () => true,
      publish,
    });
    try {
      backlog.forEach((row) => owner.prepare(row, undefined));
      owner.start();
      await withinTest(admitted.promise, signal);
      if (mode === "reset") {
        resetGatewayWorkAdmission();
      } else {
        markGatewayRestartDraining(mode === "stop" ? "stop (SIGTERM)" : "restart");
      }
      pending.resolve({ lastMessagePreview: "accepted work settled" });
      await pending.promise;
      await nextTurn();
      await nextTurn();
      expect(publish).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve({ lastMessagePreview: "cleanup" });
      owner.dispose();
    }
  },
);
it("reversible signal rollback permits work; reset starts a fresh owner only", async ({
  signal,
}) => {
  vi.spyOn(transcript, "backfillSessionRowTranscriptFields").mockResolvedValue({
    lastMessagePreview: "reply",
  });
  const backlog = rows();
  const completed = createDeferredCore();
  const published: string[] = [];
  const makeOwner = () =>
    createSessionRowProjectionBackfill({
      ready: async () => {},
      read: (id) => backlog.find((row) => identity(row) === id),
      current: () => true,
      publish: (row) => {
        published.push(row.key);
        completed.resolve();
      },
    });
  const old = makeOwner();
  let fresh: ReturnType<typeof makeOwner> | undefined;
  try {
    const fence = beginGatewayRestartSignalAdmission();
    old.prepare(backlog[0]!, undefined);
    old.start();
    await withinTest(completed.promise, signal);
    expect(published).toEqual(["one"]);
    expect(fence?.rollback()).toBe(true);
    resetGatewayWorkAdmission();
    old.prepare(backlog[1]!, undefined);
    await nextTurn();
    await nextTurn();
    expect(published).toEqual(["one"]);
    fresh = makeOwner();
    fresh.prepare(backlog[1]!, undefined);
    fresh.start();
    await nextTurn();
    await nextTurn();
    expect(published).toEqual(["one", "two"]);
  } finally {
    old.dispose();
    fresh?.dispose();
  }
});
