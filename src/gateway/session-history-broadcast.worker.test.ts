import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import * as projection from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createHandler,
  loadAccessorSessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  readSessionMessageByIdAsyncMock,
  readSessionMessageCountAsyncMock,
  runtimeConfigState,
  sessionRow,
} from "./server-session-events.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function seedBroadcastHistory(storePath: string) {
  const readers = await vi.importActual<typeof import("./session-transcript-readers.js")>(
    "./session-transcript-readers.js",
  );
  readSessionMessageByIdAsyncMock.mockImplementation(readers.readSessionMessageByIdAsync);
  readSessionMessageCountAsyncMock.mockImplementation(readers.readSessionMessageCountAsync);
  runtimeConfigState.value = {};
  setRuntimeConfigSnapshot(runtimeConfigState.value);
  loadGatewaySessionRowMock.mockReturnValue(sessionRow);
  const target = {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  };
  const entry = { sessionId: target.sessionId, updatedAt: 1 };
  await replaceSessionEntry(target, entry);
  await replaceTranscriptEvents(target, [
    { type: "session", version: 3, id: target.sessionId },
    ...(
      [
        ["question", null, "user", "Stored question"],
        ["answer", "question", "assistant", "Stored answer"],
      ] as const
    ).map(([id, parentId, role, content]) => ({
      type: "message",
      id,
      parentId,
      message: { role, content },
    })),
  ]);
  await waitForSessionTranscriptProjection(target);
  loadAccessorSessionEntryReadOnlyMock.mockReturnValue(entry);
  return { target, readers, ...createHandler(false) };
}

it.each(["by-id", "count"] as const)(
  "awaits the stored %s read without host SQLite before broadcasting",
  (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { target, readers, handler, broadcastToConnIds } = await seedBroadcastHistory(
        state.statePath("broadcast.sqlite"),
      );
      const held = createDeferredCore();
      const release = createDeferredCore();
      const hold =
        <Args extends unknown[], T>(read: (...args: Args) => Promise<T>) =>
        async (...args: Args): Promise<T> => {
          const result = await read(...args);
          held.resolve();
          await release.promise;
          return result;
        };
      if (kind === "by-id") {
        readSessionMessageByIdAsyncMock.mockImplementation(
          hold(readers.readSessionMessageByIdAsync),
        );
      } else {
        readSessionMessageCountAsyncMock.mockImplementation(
          hold(readers.readSessionMessageCountAsync),
        );
      }
      const snapshot = vi.spyOn(projection, "withCurrentProjectionSnapshot");
      const sql = observeMainThreadSql();
      sql.calibrate();
      let eventLoopProgress = false;
      let progressedBeforeDelivery = false;
      broadcastToConnIds.mockImplementation(() => {
        progressedBeforeDelivery = eventLoopProgress;
      });
      const pending = handler({
        target,
        ...(kind === "by-id" ? { messageId: "answer" } : {}),
        message: { role: "assistant", content: "Queued answer" },
      });
      try {
        await Promise.race([
          held.promise,
          pending.then(() => {
            throw new Error("Broadcast completed before its stored read result was held");
          }),
        ]);
        await setImmediate();
        eventLoopProgress = true;
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        sql.expectIdle();
        release.resolve();
        await pending;
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "session.message",
          expect.objectContaining({
            messageSeq: 2,
            message: expect.objectContaining({
              content: kind === "by-id" ? "Stored answer" : "Queued answer",
            }),
          }),
          expect.any(Set),
          {
            sessionEventSubscriptionKeys: [target.sessionKey],
            prepareSessionProjection: expect.any(Function),
          },
        );
        expect(progressedBeforeDelivery).toBe(true);
        sql.expectIdle();
        expect(snapshot).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        sql.restore();
        snapshot.mockRestore();
      }
    }),
);
