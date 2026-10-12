import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readSubagentRunAnnounceResultUsing } from "../../agents/subagents/announce/subagent-announce-result.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionEntryWithTranscript } from "./session-accessor.js";
import { findSessionTranscriptArchiveEventReadOnly } from "./session-accessor.sqlite-history.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionTranscriptEventMatch } from "./session-history-read.types.js";
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
    await expect(
      findSessionTranscriptArchiveEventReadOnly(scope, "private-run"),
    ).resolves.toBeUndefined();
    await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);

    await closeOpenClawAgentDatabasesAsync(state.root);
    await expect(findTranscriptEvent(scope, { kind: "latest" })).resolves.toBeUndefined();
    await expect(
      findSessionTranscriptArchiveEventReadOnly(scope, "private-run"),
    ).resolves.toBeUndefined();
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
        requesterSessionKey: "agent:main:requester",
        requesterDisplayKey: "main",
        task: "Read the matching transcript result",
        cleanup: "keep" as const,
        createdAt: 1,
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
          readSubagentRun: () => child,
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
    const hostSql = observeHostDataSql();
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

it("keeps match filters and active anchors authoritative across worker payload encodings", async () => {
  await withOpenClawTestState({ label: "transcript-match-encodings" }, async (state) => {
    for (const compressed of [false, true]) {
      const sessionId = compressed ? "compressed-matches" : "identity-matches";
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId,
        sessionKey: `agent:main:subagent:${sessionId}`,
        storePath: path.join(state.stateDir, "transcript.sqlite"),
      };
      const assistant = (id: string, runId: string, message: Record<string, unknown> = {}) => ({
        type: "message",
        id,
        parentId: null,
        padding: compressed ? "compressible payload ".repeat(256) : "",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: `Complete answer ${id}`,
          __openclaw: { runId },
          ...message,
        },
      });
      const answer = assistant("answer", "completed-run");
      const finalMirror = assistant("final-source-reply", "mirror-run", {
        openclawDeliveryMirror: { kind: "message-tool-source-reply", final: true },
      });
      const deliveryMirror = assistant("delivery-mirror", "delivery-run", {
        idempotencyKey: "shared-key",
        provider: "openclaw",
        model: "delivery-mirror",
      });
      const ordinary = assistant("ordinary", "delivery-run", { idempotencyKey: "shared-key" });
      const user = assistant("user", "other-run", {
        role: "user",
        idempotencyKey: "shared-key",
      });
      const active = assistant("active", "branch-run");
      const inactive = assistant("inactive", "branch-run");
      const leaf = { type: "leaf", id: "leaf", parentId: "inactive", targetId: "active" };
      const events = [
        { type: "session", id: sessionId, version: 3 },
        answer,
        assistant("silent", "completed-run", { content: "NO_REPLY" }),
        assistant("tool-use", "completed-run", { stopReason: "toolUse" }),
        assistant("tool-call", "completed-run", {
          content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
        }),
        assistant("empty", "completed-run", { content: " " }),
        assistant("nonfinal-source-reply", "completed-run", {
          openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false },
        }),
        finalMirror,
        assistant("mirror-silent", "mirror-run", { content: "NO_REPLY" }),
        deliveryMirror,
        ordinary,
        user,
        active,
        inactive,
        leaf,
      ];
      await replaceTranscriptEvents(scope, events);
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      expect(
        database.db
          .prepare(
            "SELECT count(*) AS count FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL",
          )
          .get(sessionId),
      ).toEqual({ count: compressed ? events.length - 2 : 0 });
      const cases: Array<{ match: SessionTranscriptEventMatch; event?: unknown }> = [
        { match: { kind: "visible-final", runId: "completed-run" }, event: answer },
        { match: { kind: "visible-final", runId: "mirror-run" }, event: finalMirror },
        { match: { kind: "visible-final", runId: "absent-run" } },
        { match: { kind: "idempotency", key: "shared-key" }, event: user },
        { match: { kind: "idempotency", key: "shared-key", assistant: true }, event: ordinary },
        {
          match: { kind: "idempotency", key: "shared-key", runId: "delivery-run" },
          event: ordinary,
        },
        {
          match: { kind: "idempotency", key: "shared-key", deliveryMirror: true },
          event: deliveryMirror,
        },
        { match: { kind: "idempotency", key: "absent-key" } },
        { match: { kind: "visible-final", runId: "branch-run" }, event: inactive },
        { match: { kind: "active-assistant", runId: "branch-run" }, event: active },
        { match: { kind: "latest" }, event: leaf },
      ];
      const hostSql = observeHostDataSql();
      try {
        for (const { match, event } of cases) {
          await expect(findTranscriptEvent(scope, match)).resolves.toEqual(
            event ? { event } : undefined,
          );
        }
        expect(hostSql.queries).toEqual([]);
      } finally {
        hostSql.restore();
      }
    }
  });
});
