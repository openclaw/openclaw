import { AsyncResource } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
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
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import { readSessionTranscriptWatermarkAsync } from "./session-transcript-watermark.js";
import { historyLane } from "./session-transcript-worker-resources.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

it("reads a prepared transcript snapshot while another writer owns the FIFO", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "prepared-read-writer-fifo" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "prepared-read",
      sessionKey: "agent:main:prepared-read",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync({ role: "user", content: "committed", timestamp: 1 });
    const before = await readSessionTranscriptWatermarkAsync(target);
    const outside = AsyncResource.bind(<T>(run: () => T) => run());
    const entered = createDeferred();
    const release = createDeferred();
    const writer = runOpenClawAgentWriteAdmission(
      { agentId: target.agentId, path: target.storePath },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    let snapshot: ReturnType<typeof readSessionTranscriptWatermarkAsync> | undefined;
    try {
      await withinTest(entered.promise, signal);
      snapshot = outside(() => readSessionTranscriptWatermarkAsync(target));
      expect(
        await withinTest(
          awaitGateBeforeSettlement(snapshot, writer, "Writer released before snapshot read"),
          signal,
        ),
      ).toEqual(before);
    } finally {
      release.resolve();
      await Promise.allSettled([writer, snapshot]);
    }
  });
});

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

it.each([
  ["projection", "append"],
  ["projection", "remove"],
  ["full context", "append"],
] as const)("validates a fenced %s after an owned %s", async (route, change) => {
  await withOpenClawTestState({ label: `context-${change}` }, async (state) => {
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
    const mutate = AsyncResource.bind(async () => {
      if (change === "remove") {
        expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === current)).toBe(1);
      } else {
        await manager.appendMessageAsync({ role: "user", content: "later", timestamp: 3 });
      }
    });
    const projection = runWithSessionTranscriptReadFence(
      { ...anchor, role: "user", logicalTurnId: "projection-turn" },
      () =>
        route === "projection"
          ? readSessionTranscriptContextProjectionAsync(target, async (source) => {
              const snapshot = await contextWorker.readSessionTranscriptContextMessagesInWorker(
                source.target,
                source.admission,
                undefined,
                source.physicalSource?.expectedIdentity,
              );
              await mutate();
              return { value: snapshot.messages, version: snapshot.version };
            })
          : SessionManager.readSessionContextAsync(target, async (messages) => {
              const selected = [...messages];
              await mutate();
              return selected;
            }),
    );
    if (change === "remove") {
      await expect(projection).rejects.toMatchObject({
        name: "SessionTranscriptReadFenceError",
        message: "Current-turn transcript admission changed",
      });
    } else {
      await expect(projection).resolves.toMatchObject([{ role: "user", content: "earlier" }]);
    }
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

it.each(["projection", "full context"] as const)(
  "accepts a fenced %s through a store alias but rejects a copied store",
  async (route) => {
    await withOpenClawTestState({ label: "context-input-store-alias" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "alias-input",
        sessionKey: "agent:main:alias-input",
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
      const read = (storePath: string) =>
        runWithSessionTranscriptReadFence(
          { ...anchor, role: "user", logicalTurnId: "alias-turn" },
          () =>
            route === "projection"
              ? readSessionTranscriptContextProjectionAsync(
                  { ...target, storePath },
                  async (source) => {
                    const snapshot =
                      await contextWorker.readSessionTranscriptContextMessagesInWorker(
                        source.target,
                        source.admission,
                        undefined,
                        source.physicalSource?.expectedIdentity,
                      );
                    return { value: snapshot.messages, version: snapshot.version };
                  },
                )
              : SessionManager.readSessionContextAsync({ ...target, storePath }, (messages) => [
                  ...messages,
                ]),
        );
      const alias = state.statePath("alias");
      await fs.symlink(
        path.dirname(target.storePath),
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(read(path.join(alias, "transcript.sqlite"))).resolves.toMatchObject([
        { role: "user", content: "earlier" },
      ]);
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      const copy = state.statePath("copied.sqlite");
      await fs.copyFile(target.storePath, copy);
      await expect(read(copy)).rejects.toThrow("different transcript store");
    });
  },
);

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

it.each(["worker", "native"] as const)(
  "reads actual %s admission and completed-turn receipts through either store locator",
  async (mode) => {
    await withOpenClawTestState({ label: `context-anchor-locators-${mode}` }, async (state) => {
      const originalPath = state.statePath("transcript.sqlite");
      const aliasDirectory = state.path("database-alias");
      await fs.symlink(
        path.dirname(originalPath),
        aliasDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      const aliasPath = path.join(aliasDirectory, path.basename(originalPath));
      for (const writeAlias of [false, true]) {
        const target = {
          agentId: "main",
          sessionId: `anchor-locator-${writeAlias}`,
          sessionKey: `agent:main:anchor-locator-${writeAlias}`,
          storePath: writeAlias ? aliasPath : originalPath,
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const manager =
          mode === "worker" ? await SessionManager.openAsync(target) : SessionManager.open(target);
        const earlier = { role: "user" as const, content: "earlier", timestamp: 1 };
        const current = { role: "user" as const, content: "current", timestamp: 2 };
        if (mode === "worker") {
          await manager.appendMessageAsync(earlier);
        } else {
          manager.appendMessage(earlier);
          await waitForSessionTranscriptProjection(target);
        }
        const receipt =
          mode === "worker"
            ? await manager.appendMessageWithTranscriptAnchorAsync(current)
            : manager.appendMessageWithTranscriptAnchor(current);
        if (!receipt.anchor) {
          throw new Error("Missing actual append receipt anchor");
        }
        for (const storePath of [originalPath, aliasPath]) {
          const readTarget = { ...target, storePath };
          const admitted = await SessionManager.openModelContextAsync(readTarget, {
            admission: { ...receipt.anchor, role: "user", logicalTurnId: target.sessionId },
          });
          expect(admitted.buildSessionContext().messages).toEqual([earlier]);
          const completed = await SessionManager.openModelContextAsync(readTarget, {
            through: receipt.anchor,
          });
          expect(completed.buildSessionContext().messages).toEqual([earlier, current]);
        }
        if (mode === "native") {
          expect(receipt.anchor.storePath).toBe(target.storePath);
        }
        const native = SessionManager.openModelContext(
          { ...target, storePath: receipt.anchor.storePath },
          { through: receipt.anchor },
        );
        expect(native.buildSessionContext().messages).toEqual([earlier, current]);
      }
    });
  },
);
