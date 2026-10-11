import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionEntryWithTranscript, loadTranscriptEvents } from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import * as targetWorker from "./session-transcript-read-worker-runtime.js";

const events = [
  { type: "session", id: "raw-events", version: 3 },
  {
    type: "message",
    id: "question",
    parentId: null,
    message: { role: "user", content: "雪🦞" },
  },
  {
    type: "message",
    id: "first-branch",
    parentId: "question",
    message: { role: "assistant", content: "first answer" },
  },
  {
    type: "message",
    id: "sibling-branch",
    parentId: "question",
    message: { role: "assistant", content: "alternate answer" },
  },
  { type: "leaf", id: "selected-leaf", parentId: "first-branch" },
];

it("reads all ordered raw events and byte bounds without caller SQL, including cold target discovery", async () => {
  await withOpenClawTestState({ label: "transcript-events-worker" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "raw-events",
      sessionKey: "agent:main:raw-events",
      storePath: state.statePath("transcript.sqlite"),
    };
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
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "raw-events",
      sessionKey: "agent:main:raw-events",
      storePath: state.statePath("transcript.sqlite"),
    };
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
      const scope = {
        agentId: "main",
        env: { ...state.env },
        sessionId: "raw-events",
        sessionKey: "agent:main:raw-events",
        storePath: state.statePath("transcript.sqlite"),
      };
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
          await expect(pending).rejects.toThrow("captured database owner");
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

it("keeps incognito events with their native owner without creating durable state", async () => {
  await withOpenClawTestState({ label: "transcript-events-incognito" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "raw-events",
      sessionKey: "agent:main:dashboard:incognito-events",
      storePath: state.statePath("unused.sqlite"),
    };
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { incognito: true, sessionId: scope.sessionId, updatedAt: 1 },
    }));
    await replaceTranscriptEvents(scope, events);
    await expect(loadTranscriptEvents(scope)).resolves.toEqual(events);
    await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);
    await closeOpenClawAgentDatabasesAsync(state.root);
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
    await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);
  });
});
