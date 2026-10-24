import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readSubagentRunAnnounceResultUsing } from "../../agents/subagents/announce/subagent-announce-result.js";
import { readSessionMessageByIdAsync } from "../../gateway/session-transcript-readers.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { createSessionEntryWithTranscript } from "./session-accessor.js";
import { findSessionTranscriptArchiveEventReadOnly } from "./session-accessor.sqlite-history.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import type { SessionTranscriptEventMatch } from "./session-history-read.types.js";
import { loadSessionTranscriptEvents } from "./session-transcript-events.js";
import { findTranscriptEvent } from "./session-transcript-match.js";

afterEach(() => memorySessionActorOwners.reset());

function assistant(id: string, runId: string, message: Record<string, unknown> = {}) {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      stopReason: "stop",
      content: `Complete answer ${id}`,
      __openclaw: { runId },
      ...message,
    },
  };
}

function transcriptScope(state: OpenClawTestState, sessionId: string, incognito = false) {
  const scope = {
    agentId: "main",
    env: state.env,
    sessionId,
    sessionKey: incognito
      ? "agent:main:dashboard:incognito-matching"
      : `agent:main:subagent:${sessionId}`,
    storePath: incognito
      ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
      : path.join(state.stateDir, "transcript.sqlite"),
  };
  expect(scope.storePath.startsWith(state.root)).toBe(true);
  expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
  return scope;
}

const canvasDetails = (id: string) => ({
  kind: "canvas",
  view: { id },
  presentation: { target: "assistant_message" },
});

it("keeps incognito matching and raw reads in their memory owner without creating disk state", () =>
  withOpenClawTestState({ label: "transcript-incognito-matching" }, async (state) => {
    const scope = transcriptScope(state, "private-answer", true);
    const expectNoArchiveOrDisk = async () => {
      await expect(
        findSessionTranscriptArchiveEventReadOnly(scope, "private-run"),
      ).resolves.toBeUndefined();
      await expect(fs.readdir(state.stateDir, { recursive: true })).resolves.toEqual([]);
    };
    await expect(findTranscriptEvent(scope, { kind: "latest" })).resolves.toBeUndefined();
    const answer = assistant("private-final", "private-run", {
      content: "private complete answer",
    });
    const unrelated = assistant("other-final", "other-run", { content: "other run" });
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { incognito: true, sessionId: scope.sessionId, updatedAt: 1 },
      transcriptEvents: [answer, unrelated],
    }));

    await expect(
      findTranscriptEvent(scope, { kind: "visible-final", runId: "private-run" }),
    ).resolves.toEqual({ event: answer });
    await expect(findTranscriptEvent(scope, { kind: "latest" })).resolves.toEqual({
      event: unrelated,
    });
    await expect(loadSessionTranscriptEvents(scope)).resolves.toEqual([answer, unrelated]);
    await expectNoArchiveOrDisk();

    memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
    await expect(findTranscriptEvent(scope, { kind: "latest" })).resolves.toBeUndefined();
    await expect(loadSessionTranscriptEvents(scope)).resolves.toEqual([]);
    await expectNoArchiveOrDisk();
  }));

it("recovers the exact complete child answer without preventing host event progress", () =>
  withOpenClawTestState({ label: "transcript-responsiveness" }, async (state) => {
    const target = transcriptScope(state, "synthetic-child");
    const { sessionId, sessionKey } = target;
    const fullAnswer = "Full final answer " + "complete ".repeat(1024) + "required-tail";
    const events = [
      { type: "session", id: sessionId, version: 3 },
      assistant("earlier", "completed-run", { content: "earlier commentary" }),
      assistant("answer", "completed-run", { content: fullAnswer }),
      ...Array.from({ length: 512 }, (_, index) => ({
        type: "message",
        id: `tool-${index}`,
        message: { role: "toolResult", content: "x".repeat(64 * 1024) },
      })),
      assistant("latest", "latest-run", { content: "newest unrelated answer" }),
    ];
    await seedUnindexedTranscriptForTest({
      ...target,
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
      try {
        const prepared = await readSubagentRunAnnounceResultUsing(child, {
          readSubagentRun: () => child,
          getRuntimeConfig: () => ({}),
          readSubagentSessionEntry: () => {
            throw new Error("Unexpected session fallback");
          },
          resolveSessionStorePathCore: () => {
            throw new Error("Unexpected store fallback");
          },
          findTranscriptEvent: (scope, match) =>
            findTranscriptEvent({ ...scope, env: state.env }, match),
          findSessionTranscriptArchiveEventReadOnly,
        });
        return { prepared, hostProgressBeforeResult: hostEventObserved };
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
    expect(old.hostProgressBeforeResult).toBe(true);
  }));

it("keeps match filters and active anchors authoritative across worker payload encodings", () =>
  withOpenClawTestState({ label: "transcript-match-encodings" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    for (const compressed of [false, true]) {
      const sessionId = compressed ? "compressed-matches" : "identity-matches";
      const scope = transcriptScope(state, sessionId);
      const encodedAssistant = (
        id: string,
        runId: string,
        message: Record<string, unknown> = {},
      ) => ({
        ...assistant(id, runId, message),
        parentId: null,
        padding: compressed ? "compressible payload ".repeat(256) : "",
      });
      const answer = encodedAssistant("answer", "completed-run", { display: true });
      const finalMirror = encodedAssistant("final-source-reply", "mirror-run", {
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          sourceTurnId: "mirror-run",
          final: true,
        },
      });
      const deliveryMirror = encodedAssistant("delivery-mirror", "delivery-run", {
        idempotencyKey: "shared-key",
        provider: "openclaw",
        model: "delivery-mirror",
      });
      const ordinary = encodedAssistant("ordinary", "delivery-run", {
        idempotencyKey: "shared-key",
      });
      const user = encodedAssistant("user", "other-run", {
        role: "user",
        idempotencyKey: "shared-key",
      });
      const widget = encodedAssistant("widget", "widget-run", {
        role: "toolResult",
        toolName: "show_widget",
        isError: false,
        details: canvasDetails("cv_saved"),
      });
      const nestedWidget = {
        ...encodedAssistant(
          "nested-widget",
          "widget-run",
          createNestedToolActivity({
            runId: "widget-run",
            scopeId: "widget-scope",
            afterEntryId: "widget",
            startOrder: 0,
            toolCallId: "nested-call",
            toolName: "show_widget",
            input: {},
            result: {
              content: [],
              details: canvasDetails("cv_nested"),
            },
            isError: false,
            startedAt: 1,
            timestamp: 2,
          }),
        ),
        parentId: "widget",
      };
      const active = { ...encodedAssistant("active", "branch-run"), parentId: "nested-widget" };
      const inactive = encodedAssistant("inactive", "branch-run");
      const leaf = { type: "leaf", id: "leaf", parentId: "inactive", targetId: "active" };
      const events = [
        { type: "session", id: sessionId, version: 3 },
        answer,
        encodedAssistant("silent", "completed-run", { content: "NO_REPLY" }),
        encodedAssistant("tool-use", "completed-run", { stopReason: "toolUse" }),
        encodedAssistant("tool-call", "completed-run", {
          content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
        }),
        encodedAssistant("empty", "completed-run", { content: " " }),
        encodedAssistant("nonfinal-source-reply", "completed-run", {
          openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false },
        }),
        finalMirror,
        encodedAssistant("mirror-silent", "mirror-run", { content: "NO_REPLY" }),
        deliveryMirror,
        ordinary,
        user,
        widget,
        nestedWidget,
        active,
        inactive,
        leaf,
      ];
      await replaceTranscriptEvents(scope, events);
      // Prepare the projection before observing the worker-only match reads.
      await expect(readSessionMessageByIdAsync(scope, "active")).resolves.toMatchObject({
        found: true,
      });
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      expect(
        database.db
          .prepare(
            "SELECT count(*) AS count FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL",
          )
          .get(sessionId),
      ).toEqual({ count: compressed ? events.length - 2 : 0 });
      const cases: Array<[SessionTranscriptEventMatch, unknown?]> = [
        [{ kind: "visible-final", runId: "completed-run" }, answer],
        [{ kind: "visible-final", runId: "mirror-run" }, finalMirror],
        [{ kind: "visible-final", runId: "absent-run" }],
        [{ kind: "idempotency", key: "shared-key" }, user],
        [{ kind: "idempotency", key: "shared-key", assistant: true }, ordinary],
        [{ kind: "idempotency", key: "shared-key", runId: "delivery-run" }, ordinary],
        [{ kind: "idempotency", key: "shared-key", deliveryMirror: true }, deliveryMirror],
        [{ kind: "idempotency", key: "absent-key" }],
        [{ kind: "visible-final", runId: "branch-run" }, inactive],
        [{ kind: "active-assistant", runId: "branch-run" }, active],
        [{ kind: "canvas-widget", docId: "cv_saved" }, widget],
        [{ kind: "canvas-widget", docId: "cv_nested" }, nestedWidget],
        [{ kind: "latest" }, leaf],
      ];
      const hostSql = observeHostDataSql();
      try {
        for (const [match, event] of cases) {
          await expect(findTranscriptEvent(scope, match)).resolves.toEqual(
            event ? { event } : undefined,
          );
        }
        expect(hostSql.queries).toEqual([]);
      } finally {
        hostSql.restore();
      }
    }
  }));
