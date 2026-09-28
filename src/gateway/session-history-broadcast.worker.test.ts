import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import * as projection from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { createDeferredCore } from "../shared/deferred.js";
import { AgentDatabaseRegistryChangedError } from "../state/openclaw-agent-db-registry-listing.js";
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

it.each([
  "metadata refresh",
  "continuous metadata refresh",
  "source retirement",
  "read failure",
] as const)("honors %s during initial registry discovery before publication", async (change) => {
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
    const held = createDeferredCore();
    const release = createDeferredCore();
    const readError = new Error("Registry worker read failed");
    const read = stateReads.executeExistingOpenClawStateRead;
    let registryReads = 0;
    const observation = vi
      .spyOn(stateReads, "executeExistingOpenClawStateRead")
      .mockImplementation(async (...args) => {
        const result = await read(...args);
        if (args[1].type === "agentDatabaseRegistry.read") {
          registryReads++;
          if (registryReads === 1) {
            held.resolve();
            await release.promise;
            if (change === "read failure") {
              throw readError;
            }
          } else if (change === "continuous metadata refresh") {
            // Two documented metadata retries allow three acquisitions, never unbounded churn.
            registerOpenClawAgentDatabase(registration);
          }
        }
        return result;
      });
    const pending = handler(update);
    try {
      await Promise.race([
        held.promise,
        pending.then(() => {
          throw new Error("Publication completed before its initial registry read");
        }),
      ]);
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
      } else if (change === "read failure") {
        await expect(pending).rejects.toBe(readError);
      } else if (change === "continuous metadata refresh") {
        await expect(pending).rejects.toBeInstanceOf(AgentDatabaseRegistryChangedError);
        expect(registryReads).toBe(3);
      } else {
        await pending;
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "session.message",
          expect.objectContaining({
            messageSeq: 2,
            message: expect.objectContaining({ content: "Stored answer" }),
          }),
          expect.any(Set),
        );
      }
      if (change !== "metadata refresh") {
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      observation.mockRestore();
    }
  });
});
