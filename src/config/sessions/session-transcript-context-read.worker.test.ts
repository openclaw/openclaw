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
import { upsertSessionEntryCore } from "./session-accessor.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { hasSessionTranscriptMessage } from "./session-transcript-message-presence.js";
import * as contextWorker from "./session-transcript-read-worker-runtime.js";
import { readSessionTranscriptWatermarkAsync } from "./session-transcript-watermark.js";
import * as historyReaders from "./session-transcript-worker-readers.js";

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
    const createReaders = historyReaders.createSessionHistoryWorkerReaders;
    const spy = vi
      .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
      .mockImplementation((runRequest) => {
        const readers = createReaders(runRequest);
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
