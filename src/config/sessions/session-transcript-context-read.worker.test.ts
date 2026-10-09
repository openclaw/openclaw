import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
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
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { readSessionTranscriptContextProjectionAsync } from "./session-transcript-context-read.js";
import * as transcriptReaders from "./session-transcript-execution-read.js";
import { hasSessionTranscriptMessage } from "./session-transcript-message-presence.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import * as contextWorker from "./session-transcript-read-worker-runtime.js";
import { readSessionTranscriptWatermarkAsync } from "./session-transcript-watermark.js";

it("validates context projection inside a transcript lock and append preparation", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "locked-context-projection" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "locked-context",
      sessionKey: "agent:main:locked-context",
      storePath: state.statePath("transcript.sqlite"),
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
      await expect(project()).resolves.toMatchObject([{ role: "user", content: "earlier" }]);
      await locked.appendMessage({
        message: { role: "user", content: "later", timestamp: 2 },
        prepareMessageAfterIdempotencyCheckAsync: async (message) => {
          await expect(project()).resolves.toMatchObject([{ role: "user", content: "earlier" }]);
          return message;
        },
      });
      await expect(project()).resolves.toMatchObject([
        { role: "user", content: "earlier" },
        { role: "user", content: "later" },
      ]);
    });
  });
});

it.each(["admission", "later-append"] as const)(
  "validates a retained projection after a %s change without rejecting valid fenced history",
  async (change) => {
    await withOpenClawTestState({ label: `projection-${change}` }, async (state) => {
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
            if (change === "admission") {
              await runOpenClawAgentWriteAdmission(
                { agentId: target.agentId, path: target.storePath },
                () => {
                  const foreign = new DatabaseSync(target.storePath);
                  try {
                    expect(
                      foreign
                        .prepare(
                          "UPDATE transcript_event_identities SET parent_id = ? WHERE session_id = ? AND event_id = ?",
                        )
                        .run("foreign-parent", target.sessionId, anchor.entryId).changes,
                    ).toBe(1);
                  } finally {
                    foreign.close();
                  }
                },
              );
            } else {
              await manager.appendMessageAsync({ role: "user", content: "later", timestamp: 3 });
            }
            return { value: snapshot.messages, version: snapshot.version };
          }),
      );
      if (change === "admission") {
        await expect(projection).rejects.toThrow(
          "Current-turn transcript admission identity changed",
        );
      } else {
        await expect(projection).resolves.toMatchObject([{ role: "user", content: "earlier" }]);
      }
    });
  },
);

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
