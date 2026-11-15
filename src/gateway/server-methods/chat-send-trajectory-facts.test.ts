import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import * as retention from "../../trajectory/runtime-retention.js";
import { createSqliteTrajectoryRuntimeSink } from "../../trajectory/runtime-store-writer.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import { createTrajectoryEvent } from "../../trajectory/runtime-store.test-support.js";
import * as windows from "../../trajectory/runtime-window-facts.js";
import {
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
} from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { emitSessionsChanged } from "./session-change-event.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

it("reuses trajectory facts through chat admission, metadata notices, and another recorder's append", async ({
  signal,
}) => {
  const fixture = await createFixture({ active: false });
  const completed = createDeferred();
  const take = vi.spyOn(windows, "takeTrajectoryRuntimeWindowFacts");
  const sweep = vi.spyOn(retention, "scheduleSqliteTrajectoryRuntimeRetention");
  const createSink = () =>
    createSqliteTrajectoryRuntimeSink({
      env: process.env,
      sessionId: fixture.scope.sessionId,
      sessionTarget: fixture.scope,
      maxRuntimeFileBytes: 1024 * 1024,
    });
  const first = await createSink();
  assert(first);
  const events = ["seed", "warm", "started", "other-run", "continued"].map((type) =>
    createTrajectoryEvent({
      type,
      sessionId: fixture.scope.sessionId,
      runId: type === "other-run" ? "other-run" : fixture.params.idempotencyKey,
    }),
  );
  const append = async (sink: typeof first, index: number) => {
    const event = events[index]!;
    sink.write(event, JSON.stringify(event));
    await sink.flush();
    await sweep.mock.results.at(-1)?.value;
  };
  dispatchInboundMessageMock.mockReset();
  gatewayReplyMock.mockImplementation(async (_ctx, options) => {
    try {
      assert(options?.onAgentRunStart);
      options.onAgentRunStart(fixture.params.idempotencyKey);
      await append(first, 2);
      expect(take.mock.results.at(-1)?.value).toEqual({
        nextSeq: 2,
        retainedBytes: events
          .slice(0, 2)
          .reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1, 0),
      });

      emitSessionsChanged(
        fixture.context,
        { agentId: fixture.scope.agentId, sessionKey: fixture.scope.sessionKey, reason: "send" },
        { accessChanged: false },
      );
      const other = await createSink();
      assert(other);
      await append(other, 3);
      expect(take.mock.results.at(-1)?.value).toMatchObject({ nextSeq: 3 });
      await append(first, 4);
      expect(take.mock.results.at(-1)?.value).toMatchObject({ nextSeq: 4 });
      expect(await loadSqliteTrajectoryRuntimeEvents(fixture.scope)).toEqual(events);
      completed.resolve();
    } catch (error) {
      completed.reject(error);
      throw error;
    }
    return undefined;
  });
  try {
    await append(first, 0);
    // First admission's retention sweep deliberately drops the initial window.
    await append(first, 1);
    await fixture.send();
    await withinTest(completed.promise, signal);
  } finally {
    await fixture.cleanup();
    vi.restoreAllMocks();
  }
});
