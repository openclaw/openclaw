import assert from "node:assert/strict";
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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore, withTranscriptWriteLock } from "./session-accessor.js";
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

async function targetFor(
  state: OpenClawTestState,
  sessionId: string,
  filename = "transcript.sqlite",
) {
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: state.statePath(filename),
  };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  return target;
}

async function projectMessages(
  source: Parameters<Parameters<typeof readSessionTranscriptContextProjectionAsync>[1]>[0],
  signal?: AbortSignal,
) {
  const snapshot = await contextWorker.readSessionTranscriptContextMessagesInWorker(
    source.target,
    source.admission,
    signal,
    source.physicalSource?.expectedIdentity,
  );
  return { value: snapshot.messages, version: snapshot.version };
}

function blockIndependentHistory() {
  const entered = createDeferred();
  const blocked = createDeferred<never>();
  void blocked.promise.catch(() => {});
  const spy = vi.spyOn(historyLane.pool, "run").mockImplementation(() => {
    entered.resolve();
    return blocked.promise;
  });
  return {
    entered: entered.promise,
    async close(reading: Promise<unknown> | undefined) {
      blocked.reject(new Error("Synthetic history custody released"));
      await reading?.catch(() => {});
      spy.mockRestore();
    },
  };
}

function userMessage(content: string, timestamp = 1) {
  return { role: "user" as const, content, timestamp };
}

it("reads a prepared transcript snapshot while another writer owns the FIFO", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "prepared-read-writer-fifo" }, async (state) => {
    const target = await targetFor(state, "prepared-read");
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync(userMessage("committed"));
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

it.each(["delta", "context"] as const)(
  "keeps %s reads with their writer during lock and append preparation",
  async (route, { signal }) => {
    await withOpenClawTestState({ label: `locked-${route}` }, async (state) => {
      const target = await targetFor(
        state,
        `locked-${route}`,
        route === "context" ? "sessions.json" : "transcript.sqlite",
      );
      const manager = await SessionManager.openAsync(target);
      await manager.appendMessageAsync(userMessage("earlier"));
      const run = () =>
        withTranscriptWriteLock(target, async (locked) => {
          const history = blockIndependentHistory();
          let reading: Promise<unknown> | undefined;
          const read = () => {
            reading =
              route === "delta"
                ? withSessionTranscriptDeltaReader(target, (reader) => reader.raw({}))
                : readSessionTranscriptContextProjectionAsync(
                    target,
                    (source) => projectMessages(source, signal),
                    signal,
                  );
            return Promise.race([
              reading,
              history.entered.then(() => {
                throw new Error("Writer waited on independent history custody");
              }),
            ]);
          };
          const expectRead = async (includeLater = false) => {
            const messages = [{ role: "user", content: "earlier" }];
            if (includeLater) {
              messages.push({ role: "user", content: "later" });
            }
            await expect(read()).resolves.toMatchObject(
              route === "context"
                ? messages
                : {
                    kind: "page",
                    events: expect.arrayContaining([
                      expect.objectContaining({
                        event: expect.objectContaining({
                          type: "message",
                          message: expect.objectContaining(messages[0]),
                        }),
                      }),
                    ]),
                  },
            );
          };
          try {
            await expectRead();
            await locked.appendMessage({
              message: userMessage("later", 2),
              prepareMessageAfterIdempotencyCheckAsync: async (message) => {
                await expectRead();
                return message;
              },
            });
            if (route === "context") {
              await expectRead(true);
            }
          } finally {
            await history.close(reading);
          }
        });
      if (route === "context") {
        return run();
      }
      const { databaseClaim } = await loadSessionEntryForAdmission(target);
      assert(
        "kind" in databaseClaim && databaseClaim.kind === "worker" && databaseClaim.reader,
        "Expected admitted durable session reader",
      );
      try {
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: target,
            sessionReader: databaseClaim.reader,
            withTranscriptWrite: async (write) => write(),
          },
          run,
        );
      } finally {
        await databaseClaim.release();
      }
    });
  },
);

it.each([
  ["projection", "append"],
  ["projection", "remove"],
  ["full context", "append"],
] as const)("validates a fenced %s after an owned %s", async (route, change) => {
  await withOpenClawTestState({ label: `context-${change}` }, async (state) => {
    const target = await targetFor(state, "projection-admission");
    const manager = await SessionManager.openAsync(target);
    await manager.appendMessageAsync(userMessage("earlier"));
    const current = await manager.appendMessageAsync(userMessage("current", 2));
    const anchor = readActiveTranscriptEntryAnchor({ ...target, entryId: current! });
    assert(anchor, "Missing current-input anchor");
    const mutate = AsyncResource.bind(async () => {
      if (change === "remove") {
        expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === current)).toBe(1);
      } else {
        await manager.appendMessageAsync(userMessage("later", 3));
      }
    });
    const projection = runWithSessionTranscriptReadFence(
      { ...anchor, role: "user", logicalTurnId: "projection-turn" },
      () =>
        route === "projection"
          ? readSessionTranscriptContextProjectionAsync(target, async (source) => {
              const snapshot = await projectMessages(source);
              await mutate();
              return snapshot;
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
      const scope = await targetFor(state, "context-reader");
      const source = await SessionManager.openAsync(scope);
      const user = await source.appendMessageAsync(userMessage("question"));
      const answer = await source.appendMessageAsync(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "answer" }] }),
      );
      const admissionAnchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: user! });
      const through = readActiveTranscriptEntryAnchor({ ...scope, entryId: answer! });
      assert(admissionAnchor && through, "Missing fixture anchors");
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
    const scope = await targetFor(state, "delayed-context");
    const source = SessionManager.open(scope);
    source.appendMessage(userMessage("original"));
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
      const target = await targetFor(state, "alias-input");
      const manager = await SessionManager.openAsync(target);
      await manager.appendMessageAsync(userMessage("earlier"));
      const current = await manager.appendMessageAsync(userMessage("current", 2));
      const anchor = readActiveTranscriptEntryAnchor({ ...target, entryId: current! });
      assert(anchor, "Missing current-input anchor");
      const read = (storePath: string) =>
        runWithSessionTranscriptReadFence(
          { ...anchor, role: "user", logicalTurnId: "alias-turn" },
          () =>
            route === "projection"
              ? readSessionTranscriptContextProjectionAsync(
                  { ...target, storePath },
                  projectMessages,
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
    const scope = await targetFor(state, "context-close");
    const source = await SessionManager.openAsync(scope);
    await source.appendMessageAsync(userMessage("original"));
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
        const earlier = userMessage("earlier");
        const current = userMessage("current", 2);
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
        assert(receipt.anchor, "Missing actual append receipt anchor");
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
