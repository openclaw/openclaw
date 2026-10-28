import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { readSubagentRunAnnounceResultUsing } from "../../agents/subagents/announce/subagent-announce-result.js";
import { readSessionMessageByIdAsync } from "../../gateway/session-transcript-readers.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { createSessionEntryWithTranscript, replaceSessionEntry } from "./session-accessor.js";
import { findSessionTranscriptArchiveEventReadOnly } from "./session-accessor.sqlite-history.js";
import { historyActivity } from "./session-accessor.sqlite-history.test-support.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import { maintenanceConfig } from "./session-cold-storage.test-support.js";
import type { SessionTranscriptEventMatch } from "./session-history-read.types.js";
import { readLatestTranscriptAssistantTextAsync } from "./session-transcript-assistant-read.js";
import { loadSessionTranscriptEvents } from "./session-transcript-events.js";
import { findTranscriptEvent } from "./session-transcript-match.js";
import { hasSessionTranscriptMessage } from "./session-transcript-message-presence.js";

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
  return {
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
}

const canvasDetails = (id: string) => ({
  kind: "canvas",
  view: { id },
  presentation: { target: "assistant_message" },
});
const expectMatch = async (
  scope: Parameters<typeof findTranscriptEvent>[0],
  match: SessionTranscriptEventMatch,
  event?: unknown,
) => expect(await findTranscriptEvent(scope, match)).toEqual(event ? { event } : undefined);

it("keeps incognito matching and raw reads in their memory owner without creating disk state", () =>
  withOpenClawTestState({ label: "transcript-incognito-matching" }, async (state) => {
    const scope = transcriptScope(state, "private-answer", true);
    const expectNoArchiveOrDisk = async () => {
      await expect(
        findSessionTranscriptArchiveEventReadOnly(scope, "private-run"),
      ).resolves.toBeUndefined();
      expect(await listDirectoryTreeStrict(state.stateDir)).toEqual([]);
    };
    await expectMatch(scope, { kind: "latest" });
    const answer = assistant("private-final", "private-run", {
      content: "private complete answer",
    });
    const unrelated = assistant("other-final", "other-run", { content: "other run" });
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { incognito: true, sessionId: scope.sessionId, updatedAt: 1 },
      transcriptEvents: [answer, unrelated],
    }));

    await expectMatch(scope, { kind: "visible-final", runId: "private-run" }, answer);
    await expectMatch(scope, { kind: "latest" }, unrelated);
    await expect(loadSessionTranscriptEvents(scope)).resolves.toEqual([answer, unrelated]);
    await expectNoArchiveOrDisk();

    memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
    await expectMatch(scope, { kind: "latest" });
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
      const child = createSubagentRunRecord({
        runId,
        createdAt: 1,
        childSessionKey: sessionKey,
        execution: {
          status: "terminal",
          outcome: { status: "ok" },
          transcriptTarget: target,
        },
        completion: {
          required: true,
          terminalReply: { disposition: "visible", text: "bounded evidence" },
        },
      });
      let hostEventObserved = false;
      const hostEvent = yieldToEventLoop().then(() => {
        hostEventObserved = true;
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
    expect(hostSql.queries).toEqual([]);
    expect(old).toMatchObject({ prepared: { text: fullAnswer }, hostProgressBeforeResult: true });
    expect(old.prepared.isCurrent()).toBe(true);
  }));

it("keeps match filters and active anchors authoritative across worker payload encodings", () =>
  withOpenClawTestState({ label: "transcript-match-encodings" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    for (const compressed of [false, true]) {
      const sessionId = compressed ? "compressed-matches" : "identity-matches";
      const scope = transcriptScope(state, sessionId);
      const encodedAssistant = (...args: Parameters<typeof assistant>) => ({
        ...assistant(...args),
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
      const keyed = (id: string, extra: Record<string, unknown> = {}) =>
        encodedAssistant(id, "delivery-run", { idempotencyKey: "shared-key", ...extra });
      const deliveryMirror = keyed("delivery-mirror", {
        provider: "openclaw",
        model: "delivery-mirror",
      });
      const ordinary = keyed("ordinary");
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
          historyActivity({
            runId: "widget-run",
            scopeId: "widget-scope",
            afterEntryId: "widget",
            startOrder: 0,
            toolCallId: "nested-call",
            toolName: "show_widget",
            result: { content: [], details: canvasDetails("cv_nested") },
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
        encodedAssistant("unsent", "silent-run"),
        encodedAssistant("silent-final", "silent-run", { content: "NO_REPLY" }),
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
        [{ kind: "visible-final", runId: "silent-run" }],
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
          await expectMatch(scope, match, event);
        }
        expect(hostSql.queries).toEqual([]);
      } finally {
        hostSql.restore();
      }
      const latest = await readLatestTranscriptAssistantTextAsync(scope);
      await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          db.prepare(
            "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id = ?",
          ).run(sessionId);
        },
        { agentId: scope.agentId, path: scope.storePath },
      );
      await expect(
        runSessionColdStorageMaintenance({ config: maintenanceConfig(scope.storePath) }),
      ).resolves.toMatchObject({ archivedTranscripts: 1 });
      const archive = readSessionColdTranscript(database.db, sessionId);
      expect(archive).toBeDefined();
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const [match, event] of cases) {
          await expectMatch(scope, match, event);
        }
        await expect(hasSessionTranscriptMessage(scope)).resolves.toBe(true);
        await expect(readLatestTranscriptAssistantTextAsync(scope)).resolves.toEqual(latest);
        expect(readSessionColdTranscript(database.db, sessionId)).toEqual(archive);
        expect(
          database.db
            .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
            .get(sessionId),
        ).toEqual({ count: 0 });
      }
    }
  }));
