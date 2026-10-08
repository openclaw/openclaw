import { setImmediate } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import * as projection from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { historyLane } from "../config/sessions/session-transcript-worker-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
    {
      type: "message",
      id: "question",
      parentId: null,
      message: { role: "user", content: "Stored question" },
    },
    {
      type: "message",
      id: "answer",
      parentId: "question",
      message: { role: "assistant", content: "Stored answer" },
    },
  ]);
  await waitForSessionTranscriptProjection(target);
  loadAccessorSessionEntryReadOnlyMock.mockReturnValue(entry);
  return { target, readers, ...createHandler(false) };
}

it.each(["by-id", "count"] as const)(
  "awaits the stored %s read without host SQLite before broadcasting",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { target, readers, handler, broadcastToConnIds } = await seedBroadcastHistory(
        state.statePath("broadcast.sqlite"),
      );
      const held = createDeferredCore();
      const release = createDeferredCore();
      const holdResult = async <T>(pending: Promise<T>): Promise<T> => {
        const result = await pending;
        held.resolve();
        await release.promise;
        return result;
      };
      if (kind === "by-id") {
        readSessionMessageByIdAsyncMock.mockImplementation(
          (...args: Parameters<typeof readers.readSessionMessageByIdAsync>) =>
            holdResult(readers.readSessionMessageByIdAsync(...args)),
        );
      } else {
        readSessionMessageCountAsyncMock.mockImplementation(
          (...args: Parameters<typeof readers.readSessionMessageCountAsync>) =>
            holdResult(readers.readSessionMessageCountAsync(...args)),
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
          { prepareSessionProjection: expect.any(Function) },
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
    });
  },
);

it.each(["metadata refresh", "source retirement"] as const)(
  "honors %s while a native primary reply awaits publication",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { target, handler, broadcastToConnIds } = await seedBroadcastHistory(
        resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      );
      const sibling = openOpenClawAgentDatabase({ agentId: "other", env: state.env });
      const update = {
        target,
        messageId: "answer",
        message: { role: "assistant", content: "Queued answer" },
      };
      await handler(update);
      broadcastToConnIds.mockClear();
      const registration = { agentId: "other", path: sibling.path, env: state.env };
      registerOpenClawAgentDatabase(registration);
      const held = createDeferredCore<unknown>();
      const release = createDeferredCore();
      const read = stateReads.executeExistingOpenClawStateRead;
      let registryReads = 0;
      const registryObservation = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          if (args[1].type === "agentDatabaseRegistry.read") {
            registryReads++;
            throw new Error("Registry worker read failed");
          }
          return read(...args);
        });
      const run = historyLane.pool.run;
      const nativeObservation = vi
        .spyOn(historyLane.pool, "run")
        .mockImplementation(async (...args) => {
          const reply = await run(...args);
          if (reply.ok && asOptionalRecord(reply.value)?.kind === "message-by-id") {
            held.resolve(reply.value);
            await release.promise;
          }
          return reply;
        });
      const pending = handler(update);
      try {
        const nativeReply = await Promise.race([
          held.promise,
          pending.then(() => {
            throw new Error("Publication completed before its native primary reply was released");
          }),
        ]);
        expect(nativeReply).toMatchObject({
          kind: "message-by-id",
          result: { found: true, seq: 2, message: { content: "Stored answer" } },
        });
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        if (change === "source retirement") {
          await closeOpenClawStateDatabaseByPathAsync(openOpenClawStateDatabase().path);
          openOpenClawStateDatabase();
        } else {
          registerOpenClawAgentDatabase(registration);
        }
        release.resolve();
        if (change === "source retirement") {
          await expect(pending).rejects.toMatchObject({
            code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
          });
          expect(broadcastToConnIds).not.toHaveBeenCalled();
        } else {
          await pending;
          expect(broadcastToConnIds).toHaveBeenCalledWith(
            "session.message",
            expect.objectContaining({
              messageSeq: 2,
              message: expect.objectContaining({ content: "Stored answer" }),
            }),
            expect.any(Set),
            { prepareSessionProjection: expect.any(Function) },
          );
        }
        expect(registryReads).toBe(0);
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        nativeObservation.mockRestore();
        registryObservation.mockRestore();
      }
    });
  },
);
