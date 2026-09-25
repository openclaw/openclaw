import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readSubagentRunAnnounceResultUsing } from "../../agents/subagents/announce/subagent-announce-result.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionEntryWithTranscript } from "./session-accessor.js";
import { findSessionTranscriptArchiveEventReadOnly } from "./session-accessor.sqlite-history.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { findTranscriptEvent } from "./session-transcript-match.js";

it("keeps incognito matching in its process-owned store without creating disk state", async () => {
  await withOpenClawTestState({ label: "transcript-incognito-matching" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "private-answer",
      sessionKey: "agent:main:dashboard:incognito-matching",
      storePath: state.statePath("unused-durable.sqlite"),
    };
    expect(scope.storePath.startsWith(state.root)).toBe(true);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
    await expect(findTranscriptEvent(scope, { kind: "latest" })).resolves.toBeUndefined();
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { incognito: true, sessionId: scope.sessionId, updatedAt: 1 },
    }));
    const answer = {
      type: "message",
      id: "private-final",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "private complete answer",
        __openclaw: { runId: "private-run" },
      },
    };
    const unrelated = {
      ...answer,
      id: "other-final",
      message: { ...answer.message, content: "other run", __openclaw: { runId: "other-run" } },
    };
    await replaceTranscriptEvents(scope, [answer, unrelated]);

    await expect(
      findTranscriptEvent(scope, { kind: "visible-final", runId: "private-run" }),
    ).resolves.toEqual({ event: answer });
    await expect(findTranscriptEvent(scope, { kind: "latest" })).resolves.toEqual({
      event: unrelated,
    });
    await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);

    await closeOpenClawAgentDatabasesAsync(state.root);
    await expect(findTranscriptEvent(scope, { kind: "latest" })).resolves.toBeUndefined();
    await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);
  });
});

it("recovers the exact complete child answer without preventing host event progress", async () => {
  await withOpenClawTestState({ label: "transcript-responsiveness" }, async (state) => {
    const storePath = path.join(state.stateDir, "transcript.sqlite");
    expect(storePath.startsWith(state.root)).toBe(true);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
    const sessionId = "synthetic-child";
    const sessionKey = "agent:main:subagent:synthetic-child";
    const target = { agentId: "main", sessionId, sessionKey, storePath };
    const fullAnswer = "Full final answer " + "complete ".repeat(1024) + "required-tail";
    const assistant = (runId: string, text: string, id: string) => ({
      type: "message",
      id,
      message: { role: "assistant", stopReason: "stop", content: text, __openclaw: { runId } },
    });
    const events = [
      { type: "session", id: sessionId, version: 3 },
      assistant("completed-run", "earlier commentary", "earlier"),
      assistant("completed-run", fullAnswer, "answer"),
      ...Array.from({ length: 512 }, (_, index) => ({
        type: "message",
        id: `tool-${index}`,
        message: { role: "toolResult", content: "x".repeat(64 * 1024) },
      })),
      assistant("latest-run", "newest unrelated answer", "latest"),
    ];
    await seedUnindexedTranscriptForTest({
      ...target,
      env: state.env,
      entry: { sessionId, updatedAt: 1 },
      events: events.map((event, seq) => ({
        session_id: sessionId,
        seq,
        created_at: seq + 1,
        event_json: JSON.stringify(event),
      })),
    });
    const read = async (runId: string) => {
      const child = {
        runId,
        childSessionKey: sessionKey,
        execution: {
          status: "terminal" as const,
          outcome: { status: "ok" as const },
          transcriptTarget: target,
        },
        completion: {
          required: true,
          terminalReply: { disposition: "visible" as const, text: "bounded evidence" },
        },
      };
      let hostEventObserved = false;
      const hostEvent = new Promise<void>((resolve) => {
        setImmediate(() => {
          hostEventObserved = true;
          resolve();
        });
      });
      const started = performance.now();
      try {
        const prepared = await readSubagentRunAnnounceResultUsing(child, {
          getRuntimeConfig: () => ({}),
          readSubagentSessionEntry: () => {
            throw new Error("Unexpected session fallback");
          },
          resolveAgentIdFromSessionKey: () => {
            throw new Error("Unexpected agent fallback");
          },
          resolveSessionStorePathCore: () => {
            throw new Error("Unexpected store fallback");
          },
          findTranscriptEvent: (scope, match) =>
            findTranscriptEvent({ ...scope, env: state.env }, match),
          findSessionTranscriptArchiveEventReadOnly,
        });
        const elapsedMs = performance.now() - started;
        const hostProgressBeforeResult = hostEventObserved;
        return { prepared, elapsedMs, hostProgressBeforeResult };
      } finally {
        await hostEvent;
      }
    };
    const latest = await read("latest-run");
    expect(latest.prepared.text).toBe("newest unrelated answer");
    const hostSql = observeHostDataSql(state.env);
    const old = await read("completed-run").finally(() => hostSql.restore());
    for (const call of hostSql.calls) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(old.prepared.text).toBe(fullAnswer);
    expect(old.prepared.isCurrent()).toBe(true);
    console.log(
      JSON.stringify({
        contract: "exact-run-final-answer-host-progress",
        payloadRows: 512,
        payloadBytesPerRow: 65536,
        control: {
          elapsedMs: latest.elapsedMs,
          hostProgressBeforeResult: latest.hostProgressBeforeResult,
        },
        olderRun: {
          elapsedMs: old.elapsedMs,
          hostProgressBeforeResult: old.hostProgressBeforeResult,
        },
      }),
    );
    expect(old.hostProgressBeforeResult).toBe(true);
  });
});
