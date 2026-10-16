import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadTranscriptEvents } from "./session-accessor.js";
import { appendTranscriptEvent } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { transcriptScope } from "./session-transcript-fixture.test-support.js";
import * as targetWorker from "./session-transcript-read-worker-runtime.js";

function message(id: string, parentId: string | null, role: string, content: string) {
  return {
    type: "message",
    id,
    parentId,
    message: { role, content },
  };
}
const events = [
  { type: "session", id: "raw-events", version: 3 },
  message("question", null, "user", "雪🦞"),
  message("first-branch", "question", "assistant", "first answer"),
  message("sibling-branch", "question", "assistant", "alternate answer"),
  { type: "leaf", id: "selected-leaf", parentId: "first-branch" },
];

it("appends entry-less raw events off-thread and resolves parents from current writes", async () => {
  await withOpenClawTestState({ label: "transcript-events-append-worker" }, async (state) => {
    const scope = transcriptScope(state.env, "raw-append", state.statePath("transcript.sqlite"));
    const header = { type: "session", id: scope.sessionId, version: 3 };
    const custom = (id: string, parentId: string | null) => ({
      type: "custom",
      id,
      parentId,
      customType: "raw",
    });
    const first = custom("first", null);
    const second = custom("second", "first");
    const sibling = custom("sibling", "first");
    const hostSql = observeHostDataSql();
    try {
      for (const event of [header, first, second, sibling]) {
        await expect(appendTranscriptEvent(scope, event)).resolves.toBe(true);
      }
      await expect(
        appendTranscriptEvent(scope, custom("current", "first"), { appendIntent: "active-branch" }),
      ).resolves.toBe(true);
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        header,
        first,
        second,
        sibling,
        custom("current", "sibling"),
      ]);
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
  });
});

it("reads all ordered raw events and byte bounds without caller SQL, including cold target discovery", async () => {
  await withOpenClawTestState({ label: "transcript-events-worker" }, async (state) => {
    const scope = transcriptScope(state.env, "raw-events", state.statePath("transcript.sqlite"));
    await replaceTranscriptEvents(scope, events);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    const maxEventBytes = Buffer.byteLength(
      events.map((event) => JSON.stringify(event)).join("\n"),
    );
    const absentPath = state.statePath("absent.sqlite");
    const hostSql = observeHostDataSql();
    try {
      await expect(loadTranscriptEvents({ ...scope, maxEventBytes })).resolves.toEqual(events);
      await expect(
        loadTranscriptEvents({ ...scope, maxEventBytes: maxEventBytes - 1 }),
      ).rejects.toBeInstanceOf(SqliteJsonlReadBudgetExceededError);
      await expect(
        loadTranscriptEvents({ ...scope, sessionId: "missing-session" }),
      ).resolves.toEqual([]);
      await expect(loadTranscriptEvents({ ...scope, storePath: absentPath })).resolves.toEqual([]);
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
    await expect(fs.stat(absentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("preserves SyntaxError across the worker boundary and releases the failed read", async () => {
  await withOpenClawTestState({ label: "transcript-events-malformed" }, async (state) => {
    const scope = transcriptScope(state.env, "raw-events", state.statePath("transcript.sqlite"));
    await replaceTranscriptEvents(scope, events);
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      env: scope.env,
      path: scope.storePath,
    });
    const update = database.db.prepare(
      "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1",
    );
    update.run("{malformed", scope.sessionId);
    const hostSql = observeHostDataSql();
    try {
      await expect(loadTranscriptEvents(scope)).rejects.toBeInstanceOf(SyntaxError);
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
    update.run(JSON.stringify(events[1]), scope.sessionId);
    await expect(loadTranscriptEvents(scope)).resolves.toEqual(events);
  });
});

it.each(["scope", "physical store"] as const)(
  "captures the %s before target discovery yields",
  async (change) => {
    await withOpenClawTestState({ label: "transcript-events-source" }, async (state) => {
      const scope = transcriptScope(
        { ...state.env },
        "raw-events",
        state.statePath("transcript.sqlite"),
      );
      await replaceTranscriptEvents(scope, events);
      await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
      const held = createDeferred();
      const release = createDeferred();
      const resolve = targetWorker.resolveSessionSqliteTargetInWorker;
      const observation = vi
        .spyOn(targetWorker, "resolveSessionSqliteTargetInWorker")
        .mockImplementation(async (...args) => {
          const result = await resolve(...args);
          held.resolve();
          await release.promise;
          return result;
        });
      const pending = loadTranscriptEvents(scope);
      try {
        await awaitGateBeforeSettlement(
          held.promise,
          pending,
          "Transcript read settled without awaiting target discovery",
        );
        if (change === "physical store") {
          const originalPath = state.statePath("original.sqlite");
          await fs.rename(scope.storePath, originalPath);
          await fs.copyFile(originalPath, scope.storePath);
          release.resolve();
          await expect(pending).rejects.toThrow("Agent database changed during repair admission");
        } else {
          scope.sessionId = "replacement";
          scope.sessionKey = "agent:other:replacement";
          scope.agentId = "other";
          scope.storePath = state.statePath("replacement.sqlite");
          scope.env.OPENCLAW_STATE_DIR = state.path("replacement-state");
          release.resolve();
          await expect(pending).resolves.toEqual(events);
          await expect(fs.stat(scope.storePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        observation.mockRestore();
      }
    });
  },
);
