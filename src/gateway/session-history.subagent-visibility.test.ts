import assert from "node:assert/strict";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../config/sessions/session-accessor.sqlite-history-events.test-support.js";
import * as inputVisibility from "../config/sessions/session-accessor.sqlite-history-input-visibility.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionHistoryPageInWorker } from "../config/sessions/session-history-worker-runtime.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { readChatHistoryDelta } from "./server-methods/chat-history-delta.js";
import { readChatHistoryPageKernel } from "./server-methods/chat-history-page-kernel.js";
import { createPreparedSessionHistorySubagentProjection } from "./session-history-delta-visibility.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import { readSessionHistorySnapshotKernel } from "./session-history-snapshot.js";
import {
  readSessionHistorySnapshotAsync,
  SessionHistorySseState,
} from "./session-history-state.js";
import * as subagentSources from "./session-history-subagent-sources.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { collectSessionTranscriptMessages } from "./session-transcript-source-pages.js";

const childKey = "agent:main:dashboard:spawned-worker";
const peerKey = "agent:main:dashboard:independent-peer";
const forwarded = (runId: string, sourceSessionKey: string, sourceTool = "sessions_send") => ({
  ...childInput(runId),
  provenance: { kind: "inter_session", sourceTool, sourceSessionKey },
});
const childInput = (runId: string, extra: Record<string, unknown> = {}) => ({
  role: "user",
  content: "Worker integration checkpoint",
  idempotencyKey: `${runId}:user`,
  provenance: { kind: "inter_session", sourceTool: "sessions_send", sourceSessionKey: childKey },
  ...extra,
});
const response = (runId: string, text: string) => ({
  role: "assistant",
  content: text,
  stopReason: "stop",
  __openclaw: { runId },
});
const inline = async (
  history: SessionHistorySseState,
  params: Parameters<SessionHistorySseState["prepareInlineMessage"]>[0],
) => (await history.prepareInlineMessage(params))();
type HistoryScope = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
const historyDelta = (scope: HistoryScope, cursor: string) =>
  readChatHistoryDelta({
    agentId: scope.agentId,
    scope,
    sessionKey: scope.sessionKey,
    sessionSnapshot: {},
    cursor,
  });
const historyReader = (scope: HistoryScope) =>
  createReadonlySessionHistoryReader({
    transcript: { ...scope, sessionFile: scope.sessionKey },
    database: { agentId: scope.agentId, path: scope.storePath },
    entryValidationKey: scope.sessionKey,
  });

async function withHistory(
  messages: Array<[string, Record<string, unknown>]>,
  run: (fixture: {
    scope: HistoryScope;
    entry: { sessionId: string; updatedAt: number };
    readers: ReturnType<typeof createReadonlySessionHistoryReader>;
    state: OpenClawTestState;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = {
      agentId: "main",
      sessionId: "history-coordination",
      sessionKey: "agent:main:dashboard:parent",
      storePath: database.path,
    };
    const entry = { sessionId: scope.sessionId, updatedAt: 1 };
    await replaceSessionEntry(scope, entry);
    await replaceSessionEntry(
      { ...scope, sessionKey: childKey },
      { sessionId: "spawned-worker", updatedAt: 1, spawnedBy: scope.sessionKey, spawnDepth: 1 },
    );
    await replaceSessionEntry(
      { ...scope, sessionKey: peerKey },
      {
        sessionId: "independent-peer",
        updatedAt: 1,
        parentSessionKey: scope.sessionKey,
        spawnDepth: 0,
      },
    );
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      ...messages.map(([id, message], index) => ({
        type: "message" as const,
        id,
        parentId: messages[index - 1]?.[0] ?? null,
        message,
      })),
    ]);
    await waitForSessionTranscriptProjection(scope);
    await run({
      scope,
      entry,
      state,
      readers: historyReader(scope),
    });
  });
}

describe("subagent coordination history", () => {
  it("prepares inline source and run visibility without calling native readers on the host", async () => {
    await withHistory(
      [["human-input", { role: "user", content: "Question", idempotencyKey: "human-run:user" }]],
      async ({ scope, entry, readers }) => {
        setRuntimeConfigSnapshot({ agents: { entries: { main: {}, other: {} } } });
        const snapshot = await readSessionHistorySnapshotKernel(
          { target: { ...scope, sessionEntry: entry } },
          { readers, readOnly: true },
        );
        const inputRead = vi
          .spyOn(inputVisibility, "readSessionTranscriptRunInputVisibilityFromProjection")
          .mockImplementation(() => {
            throw new Error("host run visibility read");
          });
        const sourceRead = vi
          .spyOn(subagentSources, "createBoundSessionHistorySubagentSource")
          .mockImplementation(() => {
            throw new Error("host source visibility read");
          });
        try {
          for (const message of [
            { role: "user", content: "Next question" },
            response("human-run", "Visible answer"),
            {
              ...childInput("explicit-child"),
              provenance: {
                kind: "inter_session",
                sourceTool: "sessions_send",
                sourceRole: "subagent",
              },
            },
          ]) {
            const history = SessionHistorySseState.fromSnapshot({
              target: { ...scope, sessionEntry: entry },
              snapshot,
            });
            const result = (await history.prepareInlineMessage({ message, messageSeq: 2 }))();
            if ("provenance" in message) {
              expect(result).toBeNull();
              expect(history.snapshot().messages).toEqual(snapshot.history.messages);
            } else {
              expect(result?.messageSeq).toBe(2);
              expect(history.snapshot().messages).toHaveLength(2);
            }
          }
          expect(inputRead).not.toHaveBeenCalled();
          expect(sourceRead).not.toHaveBeenCalled();
        } finally {
          inputRead.mockRestore();
          sourceRead.mockRestore();
        }
      },
    );
  });

  it("hides cross-agent dashboard coordination through worker history pages and deltas", async () => {
    const sourceChild = "agent:worker:dashboard:child";
    const sourcePeer = "agent:worker:dashboard:peer";
    const messages: Array<[string, Record<string, unknown>]> = [
      ["cross-child", forwarded("cross-run", sourceChild)],
      ["cross-answer", response("cross-run", "Cross-agent internal acknowledgement")],
      ["cross-peer", forwarded("peer-run", sourcePeer)],
      ["peer-answer", response("peer-run", "Independent peer decision")],
    ];
    await withHistory(messages, async ({ scope, entry, readers, state }) => {
      const sourceDatabase = openOpenClawAgentDatabase({ agentId: "worker", env: state.env });
      expect(sourceDatabase.path).not.toBe(scope.storePath);
      for (const key of [sourceChild, sourcePeer]) {
        await replaceSessionEntry(
          { agentId: "worker", storePath: sourceDatabase.path, sessionKey: key },
          {
            sessionId: key,
            updatedAt: 1,
            spawnDepth: key === sourceChild ? 1 : 0,
            ...(key === sourceChild ? { spawnedBy: scope.sessionKey } : {}),
          },
        );
      }
      const page = await readSessionHistorySnapshotAsync({
        target: { ...scope, sessionEntry: entry },
        limit: 10,
      });
      expect
        .soft(page.history.messages.map(readChatHistoryMessageId))
        .toEqual(["cross-peer", "peer-answer"]);
      const sse = SessionHistorySseState.fromSnapshot({
        target: { ...scope, sessionEntry: entry },
        snapshot: page,
      });
      const initial = readTranscriptDisplayDelta(scope);
      assert(initial.kind === "page", "Expected a current history cursor");
      await appendTranscriptMessage(scope, {
        eventId: "cross-late",
        now: 2,
        message: forwarded("cross-late-run", sourceChild),
      });
      await appendTranscriptMessage(scope, {
        eventId: "cross-late-answer",
        now: 3,
        message: response("cross-late-run", "Later cross-agent acknowledgement"),
      });
      expect(
        await inline(sse, {
          message: forwarded("cross-late-run", sourceChild),
          messageSeq: 5,
        }),
      ).toBeNull();
      expect(
        await inline(sse, {
          message: response("cross-late-run", "Later cross-agent acknowledgement"),
          messageSeq: 6,
        }),
      ).toBeNull();
      expect(sse.snapshot().messages).toEqual(page.history.messages);
      const delta = await historyDelta(scope, initial.cursor);
      expect.soft(delta).toMatchObject({ kind: "delta", messages: [] });
      const raw = await collectSessionTranscriptMessages(
        readers.readSessionMessagesWithSourceAsync,
        scope,
        {
          mode: "full",
          reason: "raw cross-agent transcript proof",
        },
      );
      expect(raw.map(readChatHistoryMessageId)).toEqual([
        ...messages.map(([id]) => id),
        "cross-late",
        "cross-late-answer",
      ]);
    });
  });

  it("rejects prepared inline visibility when shared-state custody retires before publication", async () => {
    await withHistory([["worker-input", childInput("worker-run")]], async ({ scope, entry }) => {
      const snapshot = await readSessionHistorySnapshotAsync({
        target: { ...scope, sessionEntry: entry },
      });
      const history = SessionHistorySseState.fromSnapshot({
        target: { ...scope, sessionEntry: entry },
        snapshot,
      });
      const append = await history.prepareInlineMessage({
        message: response("worker-run", "Internal acknowledgement"),
        messageSeq: 2,
      });
      const database = openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      openOpenClawStateDatabase({ path: database.path });
      expect(append).toThrow(/state database read admission changed/u);
      expect(history.snapshot()).toBe(snapshot.history);
    });
  });

  it.each(["uncached-source", "cached-source", "cached-run", "projected-fast-path"])(
    "rejects prepared history after source authority changes (%s)",
    async (readKind) => {
      await withHistory(
        [
          ["worker-input", childInput("worker-run")],
          ["worker-answer", response("worker-run", "Internal acknowledgement")],
        ],
        async ({ scope }) => {
          const database = openOpenClawStateDatabase();
          const prepared = await readSessionHistoryPageInWorker({
            kind: "inline-visibility",
            params: {
              target: scope,
              lookup:
                readKind === "cached-run"
                  ? { kind: "run", runId: "worker-run", messageSeq: 2 }
                  : { kind: "session", sessionKey: childKey },
            },
          });
          const subagentCoordination = createPreparedSessionHistorySubagentProjection(
            prepared.subagentCoordination,
            prepared.assertCurrent,
          );
          if (readKind === "cached-source") {
            expect(subagentCoordination.isSubagentSession(childKey)).toBe(true);
          } else if (readKind === "cached-run") {
            expect(subagentCoordination.isSubagentRunMessage("worker-run", 2)).toBe(true);
          }
          await closeOpenClawStateDatabaseByPathAsync(database.path);
          openOpenClawStateDatabase({ path: database.path });
          const read = () =>
            readKind === "cached-run"
              ? subagentCoordination.isSubagentRunMessage("worker-run", 2)
              : readKind === "projected-fast-path"
                ? projectChatDisplayMessages(
                    [
                      {
                        ...childInput("worker-run"),
                        provenance: {
                          kind: "inter_session",
                          sourceTool: "sessions_send",
                          sourceRole: "subagent",
                        },
                      },
                    ],
                    { subagentCoordination },
                  )
                : subagentCoordination.isSubagentSession(childKey);
          expect(read).toThrow(/state database read admission changed/u);
        },
      );
    },
  );

  it.each(["parentSessionKey", "spawnedBy"] as const)(
    "reads ACP %s lineage from bound shared state and rejects stale bindings",
    async (parentField) => {
      const acpChild = "agent:main:acp:parent-owned";
      const staleChild = "agent:main:acp:stale-parent-owned";
      const interactivePeer = "agent:main:acp:interactive-peer";
      const keys = [acpChild, staleChild, interactivePeer];
      const messages = keys.flatMap<[string, Record<string, unknown>]>((key, index) => [
        [`acp-input-${index}`, forwarded(`acp-run-${index}`, key)],
        [`acp-answer-${index}`, response(`acp-run-${index}`, "ACP coordination response")],
      ]);
      await withHistory(messages, async ({ scope, entry }) => {
        const stateDatabasePath = path.join(
          path.dirname(scope.storePath),
          "history-acp-state.sqlite",
        );
        const cfg = { session: { store: scope.storePath }, agents: { entries: { main: {} } } };
        for (const [index, key] of keys.entries()) {
          const source = { ...scope, sessionKey: key, sessionId: `acp-session-${index}` };
          await replaceSessionEntry(source, {
            sessionId: source.sessionId,
            lifecycleRevision: `acp-revision-${index}`,
            updatedAt: 1,
            spawnDepth: 0,
            ...(key === interactivePeer ? {} : { [parentField]: scope.sessionKey }),
          });
          await upsertAcpSessionMeta({
            sessionKey: key,
            agentId: "main",
            cfg,
            databasePath: stateDatabasePath,
            mutate: () => ({
              backend: "acpx",
              agent: "codex",
              runtimeSessionName: key,
              mode: "persistent",
              state: "idle",
              lastActivityAt: 2,
            }),
            now: () => 2,
          });
          const persisted = loadSessionEntryReadOnly(source);
          assert(persisted, "Expected persisted ACP source session");
          expect(persisted).not.toHaveProperty("acp");
          if (key === staleChild) {
            await replaceSessionEntry(source, {
              ...persisted,
              sessionId: "successor-acp-session",
              lifecycleRevision: "successor-acp-revision",
            });
          }
        }
        const stateContext = captureOpenClawStateWorkerContext({ path: stateDatabasePath });
        const readers = createReadonlySessionHistoryReader({
          transcript: { ...scope, sessionFile: scope.sessionKey },
          database: { agentId: scope.agentId, path: scope.storePath },
          entryValidationKey: scope.sessionKey,
          stateDatabase: {
            path: stateContext.admission.databasePath,
            environment: stateContext.environment,
          },
        });
        const snapshot = await readSessionHistorySnapshotKernel(
          { target: { ...scope, sessionEntry: entry } },
          { readers, readOnly: true },
        );
        expect(snapshot.history.messages.map(readChatHistoryMessageId)).toEqual([
          "acp-input-1",
          "acp-answer-1",
          "acp-input-2",
          "acp-answer-2",
        ]);
      });
    },
  );

  it("hides attributed legacy worker inputs and their run chatter while preserving peer and completion outcomes", async () => {
    const messages: Array<[string, Record<string, unknown>]> = [
      ["question", { role: "user", content: "How is the release?" }],
      ["worker-input", childInput("worker-run")],
      ["worker-ack", response("worker-run", "Root accepted the unchanged checkpoint.")],
      [
        "worker-tool",
        {
          role: "toolResult",
          content: "Private coordination",
          __openclaw: { runId: "worker-run" },
        },
      ],
      ["worker-later", response("worker-run", "Nothing changed; no publication action was taken.")],
      ["removed-child-input", forwarded("removed-child-run", "agent:main:subagent:removed-child")],
      ["removed-child-answer", response("removed-child-run", "Removed child acknowledgement")],
      ["peer-input", forwarded("peer-run", peerKey)],
      ["peer-answer", response("peer-run", "Independent peer decision")],
      ["announce", forwarded("announce-run", childKey, "subagent_announce")],
      [
        "completion",
        response("announce-run", "The regression is fixed and the focused proof passes."),
      ],
      [
        "unattributed-cli",
        {
          role: "user",
          content:
            "[Inter-session message] sourceTool=sessions_send\nCLI message without provenance",
        },
      ],
      ["human-answer", response("human-run", "Here are the remaining release blockers.")],
      ["missing-source", forwarded("missing-run", "agent:main:dashboard:missing")],
    ];
    await withHistory(messages, async ({ scope, entry, readers }) => {
      const expected = [
        "question",
        "peer-input",
        "peer-answer",
        "completion",
        "unattributed-cli",
        "human-answer",
        "missing-source",
      ];
      const options = { readers, readOnly: true };
      for (const limit of [undefined, 20]) {
        const page = await readSessionHistorySnapshotKernel(
          { target: { ...scope, sessionEntry: entry }, limit },
          options,
        );
        expect(page.history.messages.map(readChatHistoryMessageId)).toEqual(expected);
        expect(page.rawTranscriptSeq).toBe(messages.length);
      }
      const page = await readChatHistoryPageKernel(
        {
          entry,
          sessionId: scope.sessionId,
          storePath: scope.storePath,
          sessionAgentId: scope.agentId,
          canonicalKey: scope.sessionKey,
          max: 20,
          maxHistoryBytes: 100_000,
          effectiveMaxChars: 8000,
          provider: undefined,
          offset: 0,
          messageId: undefined,
        },
        options,
      );
      expect(page.messages.map(readChatHistoryMessageId)).toEqual(expected);
      const raw = await collectSessionTranscriptMessages(
        readers.readSessionMessagesWithSourceAsync,
        scope,
        {
          mode: "full",
          reason: "raw model transcript proof",
        },
      );
      expect(raw.map(readChatHistoryMessageId)).toEqual(messages.map(([id]) => id));
    });
  });

  it("resolves a hidden run across a delta cursor and reveals only the answer after a human steer", async () => {
    await withHistory(
      [
        ["question", { role: "user", content: "How is the release?" }],
        ["worker-input", childInput("worker-run")],
        ["worker-ack", response("worker-run", "Accepted checkpoint")],
      ],
      async ({ scope, entry, readers }) => {
        const snapshot = await readSessionHistorySnapshotKernel(
          { target: { ...scope, sessionEntry: entry } },
          { readers, readOnly: true },
        );
        const state = SessionHistorySseState.fromSnapshot({
          target: { ...scope, sessionEntry: entry },
          snapshot,
        });
        const initial = readTranscriptDisplayDelta(scope);
        assert(initial.kind === "page", "Expected initial transcript cursor");
        const later = {
          ...response("worker-run", "Another internal acknowledgement"),
          stopReason: "error",
          errorMessage: "Internal coordination failed",
        };
        await appendTranscriptMessage(scope, { eventId: "later", now: 2, message: later });
        expect(
          await inline(state, { message: later, messageId: "later", messageSeq: 4 }),
        ).toBeNull();
        const delta = await historyDelta(scope, initial.cursor);
        expect(delta).toMatchObject({ kind: "delta", messages: [] });
        assert(delta.kind === "delta", "Expected hidden delta to advance its cursor");
        const steer = {
          role: "user",
          content: "Give me the remaining blockers.",
          __openclaw: { steerTargetRunId: "worker-run" },
        };
        const answer = response("worker-run", "The release still needs final validation.");
        await appendTranscriptMessage(scope, {
          eventId: "human-steer",
          now: 3,
          message: { ...steer, idempotencyKey: "human-steer:user" },
        });
        await appendTranscriptMessage(scope, {
          eventId: "human-answer",
          now: 4,
          message: answer,
        });
        const humanSteer = await inline(state, {
          message: steer,
          messageId: "human-steer",
          messageSeq: 5,
        });
        const humanAnswer = await inline(state, {
          message: answer,
          messageId: "human-answer",
          messageSeq: 6,
        });
        expect(humanSteer?.messageSeq).toBe(5);
        expect(humanAnswer?.message).toMatchObject({
          content: "The release still needs final validation.",
          __openclaw: { seq: 6 },
        });
        const resumed = await historyDelta(scope, delta.deltaCursor);
        expect(resumed).toMatchObject({
          kind: "delta",
          messages: [{ messageId: "human-steer" }, { messageId: "human-answer" }],
        });
        const freshReaders = historyReader(scope);
        const page = await readSessionHistorySnapshotKernel(
          { target: { ...scope, sessionEntry: entry }, limit: 2 },
          { readers: freshReaders, readOnly: true },
        );
        expect(page.history.messages.map(readChatHistoryMessageId)).toEqual([
          "human-steer",
          "human-answer",
        ]);
      },
    );
  });
});
