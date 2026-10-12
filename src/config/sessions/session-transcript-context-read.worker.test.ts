import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore, withTranscriptWriteLock } from "./session-accessor.js";
import type { SessionTranscriptRawDeltaResult } from "./session-accessor.sqlite-contract.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { readSessionTranscriptContextProjectionAsync } from "./session-transcript-context-read.js";
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";
import * as transcriptReaders from "./session-transcript-execution-read.js";
import { hasSessionTranscriptMessage } from "./session-transcript-message-presence.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import * as contextWorker from "./session-transcript-read-worker-runtime.js";
import { readSessionTranscriptWatermarkAsync } from "./session-transcript-watermark.js";
import { historyLane } from "./session-transcript-worker-resources.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

it("keeps admitted delta reads with their writer when independent history cannot settle", async () => {
  await withOpenClawTestState({ label: "locked-admitted-delta" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "locked-admitted-delta",
      sessionKey: "agent:main:locked-admitted-delta",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync({ role: "user", content: "earlier", timestamp: 1 });
    const { databaseClaim } = await loadSessionEntryForAdmission(target);
    if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
      throw new Error("Expected admitted durable session reader");
    }
    try {
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          sessionReader: databaseClaim.reader,
          withTranscriptWrite: async (write) => write(),
        },
        () =>
          withTranscriptWriteLock(target, async (locked) => {
            const independentRead = createDeferred();
            const blockedHistory = createDeferred<never>();
            void blockedHistory.promise.catch(() => {});
            const spy = vi.spyOn(historyLane.pool, "run").mockImplementation(() => {
              independentRead.resolve();
              return blockedHistory.promise;
            });
            let reading: Promise<SessionTranscriptRawDeltaResult> | undefined;
            const read = async () => {
              reading = withSessionTranscriptDeltaReader(target, (reader) => reader.raw({}));
              return await Promise.race([
                reading,
                independentRead.promise.then(() => {
                  throw new Error("Admitted writer waited on independent history custody");
                }),
              ]);
            };
            try {
              const earlier = {
                event: expect.objectContaining({
                  type: "message",
                  message: expect.objectContaining({ role: "user", content: "earlier" }),
                }),
              };
              await expect(read()).resolves.toMatchObject({
                kind: "page",
                events: expect.arrayContaining([expect.objectContaining(earlier)]),
              });
              await locked.appendMessage({
                message: { role: "user", content: "later", timestamp: 2 },
                prepareMessageAfterIdempotencyCheckAsync: async (message) => {
                  await expect(read()).resolves.toMatchObject({
                    kind: "page",
                    events: expect.arrayContaining([expect.objectContaining(earlier)]),
                  });
                  return message;
                },
              });
            } finally {
              blockedHistory.reject(new Error("Synthetic history custody released"));
              await reading?.catch(() => {});
              spy.mockRestore();
            }
          }),
      );
    } finally {
      await databaseClaim.release();
    }
  });
});

it("validates context projection inside a transcript lock and append preparation", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "locked-context-projection" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "locked-context",
      sessionKey: "agent:main:locked-context",
      storePath: state.statePath("sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync({ role: "user", content: "earlier", timestamp: 1 });
    const project = () =>
      readSessionTranscriptContextProjectionAsync(
        target,
        async (source) => {
          const snapshot = await contextWorker.readSessionTranscriptContextMessagesInWorker(
            source.target,
            source.admission,
            signal,
            source.physicalSource?.expectedIdentity,
          );
          return { value: snapshot.messages, version: snapshot.version };
        },
        signal,
      );
    await withTranscriptWriteLock(target, async (locked) => {
      const independentRead = createDeferred();
      const blockedHistory = createDeferred<never>();
      void blockedHistory.promise.catch(() => {});
      const spy = vi.spyOn(historyLane.pool, "run").mockImplementation(() => {
        independentRead.resolve();
        return blockedHistory.promise;
      });
      let reading: ReturnType<typeof project> | undefined;
      const read = async () => {
        reading = project();
        return await Promise.race([
          reading,
          independentRead.promise.then(() => {
            throw new Error("Context acceptance waited on independent history custody");
          }),
        ]);
      };
      try {
        await expect(read()).resolves.toMatchObject([{ role: "user", content: "earlier" }]);
        await locked.appendMessage({
          message: { role: "user", content: "later", timestamp: 2 },
          prepareMessageAfterIdempotencyCheckAsync: async (message) => {
            await expect(read()).resolves.toMatchObject([{ role: "user", content: "earlier" }]);
            return message;
          },
        });
        await expect(read()).resolves.toMatchObject([
          { role: "user", content: "earlier" },
          { role: "user", content: "later" },
        ]);
      } finally {
        blockedHistory.reject(new Error("Synthetic history custody released"));
        await reading?.catch(() => {});
        spy.mockRestore();
      }
    });
  });
});

it("keeps a fenced projection valid after a later append", async () => {
  await withOpenClawTestState({ label: "projection-later-append" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "projection-admission",
      sessionKey: "agent:main:projection-admission",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync({ role: "user", content: "earlier", timestamp: 1 });
    const current = await manager.appendMessageAsync({
      role: "user",
      content: "current",
      timestamp: 2,
    });
    const anchor = readActiveTranscriptEntryAnchor({ ...target, entryId: current! });
    if (!anchor) {
      throw new Error("Missing current-input anchor");
    }
    const projection = runWithSessionTranscriptReadFence(
      { ...anchor, role: "user", logicalTurnId: "projection-turn" },
      () =>
        readSessionTranscriptContextProjectionAsync(target, async (source) => {
          const snapshot = await contextWorker.readSessionTranscriptContextMessagesInWorker(
            source.target,
            source.admission,
            undefined,
            source.physicalSource?.expectedIdentity,
          );
          await manager.appendMessageAsync({ role: "user", content: "later", timestamp: 3 });
          return { value: snapshot.messages, version: snapshot.version };
        }),
    );
    await expect(projection).resolves.toMatchObject([{ role: "user", content: "earlier" }]);
  });
});

it.each([false, true])(
  "reads context, watermarks and message presence without caller SQL (warm=%s)",
  async (warm) => {
    await withOpenClawTestState({ label: "transcript-context-reader" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "context-reader",
        sessionKey: "agent:main:context-reader",
        storePath: state.statePath("transcript.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      const user = await source.appendMessageAsync({
        role: "user",
        content: "question",
        timestamp: 1,
      });
      const answer = await source.appendMessageAsync(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "answer" }] }),
      );
      const admissionAnchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: user! });
      const through = readActiveTranscriptEntryAnchor({ ...scope, entryId: answer! });
      expect(admissionAnchor).toBeDefined();
      expect(through).toBeDefined();
      if (!admissionAnchor || !through) {
        throw new Error("Missing fixture anchors");
      }
      const expected = source.buildSessionContext();
      if (warm) {
        openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
      } else {
        await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
      }
      const sql = observeHostDataSql();
      try {
        for (const options of [{}, { through }]) {
          expect(
            (await SessionManager.openModelContextAsync(scope, options)).buildSessionContext(),
          ).toEqual(expected);
        }
        const admitted = await SessionManager.openModelContextAsync(scope, {
          admission: { ...admissionAnchor, role: "user", logicalTurnId: "reader-turn" },
        });
        expect(admitted.buildSessionContext().messages).toEqual([]);
        await expect(readSessionTranscriptWatermarkAsync(scope)).resolves.toEqual({
          generation: through.generation,
          maxSeq: through.rawSeq,
        });
        await expect(hasSessionTranscriptMessage(scope)).resolves.toBe(true);
        const absent = { ...scope, sessionId: "absent", sessionKey: "agent:main:absent" };
        await expect(hasSessionTranscriptMessage(absent)).resolves.toBe(false);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  },
);

it("refuses a rewrite after final worker validation but before host consumption", async () => {
  await withOpenClawTestState({ label: "context-validation-reply" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "delayed-context",
      sessionKey: "agent:main:delayed-context",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope);
    source.appendMessage({ role: "user", content: "original", timestamp: 1 });
    const rewritten = createDeferred();
    const createReaders = transcriptReaders.createPreparedSessionTranscriptReads;
    const spy = vi
      .spyOn(transcriptReaders, "createPreparedSessionTranscriptReads")
      .mockImplementation((params) => {
        const readers = createReaders(params);
        return {
          ...readers,
          readAnchors: async (input, signal) => {
            const facts = await readers.readAnchors(input, signal);
            if (input.selection.contextValidation) {
              expect(source.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
              rewritten.resolve();
            }
            return facts;
          },
        };
      });
    const pending = SessionManager.openModelContextAsync(scope);
    try {
      await awaitGateBeforeSettlement(
        rewritten.promise,
        pending,
        "Final context validation was not intercepted",
      );
      await expect(pending).rejects.toThrow(/transcript/i);
    } finally {
      spy.mockRestore();
    }
  });
});

it("rejects a read owner closed after scanning instead of accepting the detached context", async () => {
  await withOpenClawTestState({ label: "context-reader-close" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "context-close",
      sessionKey: "agent:main:context-close",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(scope);
    await source.appendMessageAsync({ role: "user", content: "original", timestamp: 1 });
    const original = contextWorker.readSessionTranscriptModelContextInWorker;
    const spy = vi
      .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
      .mockImplementationOnce(async (...args) => {
        const context = await original(...args);
        // Start close without joining this very read; the owner must refuse disclosure and then settle.
        closing = closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
        return context;
      });
    let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
    try {
      await expect(SessionManager.openModelContextAsync(scope)).rejects.toThrow(
        /revoked|closed|current|admission/i,
      );
    } finally {
      spy.mockRestore();
      await closing;
    }
  });
});

it("refuses a copied replacement with identical context version after scanning", async () => {
  await withOpenClawTestState({ label: "context-reader-replacement" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "context-replacement",
      sessionKey: "agent:main:context-replacement",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(scope);
    await source.appendMessageAsync({ role: "user", content: "original", timestamp: 1 });
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    const original = contextWorker.readSessionTranscriptModelContextInWorker;
    const spy = vi
      .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
      .mockImplementationOnce(async (...args) => {
        const context = await original(...args);
        const previous = state.statePath("original.sqlite");
        await fs.rename(scope.storePath, previous);
        await fs.copyFile(previous, scope.storePath);
        return context;
      });
    try {
      await expect(SessionManager.openModelContextAsync(scope)).rejects.toThrow(
        "captured database owner",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
