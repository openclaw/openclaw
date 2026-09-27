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
  return { target, ...createHandler(false) };
}

it.each(["by-id", "count"] as const)(
  "keeps the event loop available while broadcasting a stored %s read",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { target, handler, broadcastToConnIds } = await seedBroadcastHistory(
        state.statePath("broadcast.sqlite"),
      );
      const snapshot = vi.spyOn(projection, "withCurrentProjectionSnapshot");
      let eventLoopProgress = false;
      const turn = setImmediate().then(() => {
        eventLoopProgress = true;
      });
      let progressedBeforeDelivery = false;
      broadcastToConnIds.mockImplementation(() => {
        progressedBeforeDelivery = eventLoopProgress;
      });
      try {
        await handler({
          target,
          ...(kind === "by-id" ? { messageId: "answer" } : {}),
          message: { role: "assistant", content: "Queued answer" },
        });
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
        expect(snapshot).not.toHaveBeenCalled();
      } finally {
        await turn;
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
] as const)("honors %s while a native primary reply awaits publication", async (change) => {
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
    const readError =
      change === "continuous metadata refresh"
        ? new AgentDatabaseRegistryChangedError()
        : new Error("Registry worker read failed");
    const read = stateReads.executeExistingOpenClawStateRead;
    let registryReads = 0;
    const registryObservation = vi
      .spyOn(stateReads, "executeExistingOpenClawStateRead")
      .mockImplementation(async (...args) => {
        if (args[1].type === "agentDatabaseRegistry.read") {
          registryReads++;
          throw readError;
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
        const refreshes = change === "continuous metadata refresh" ? 3 : 1;
        for (let refresh = 0; refresh < refreshes; refresh++) {
          registerOpenClawAgentDatabase(registration);
        }
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
});
