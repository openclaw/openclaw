import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../config/sessions/session-accessor.sqlite-history-events.js";
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
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import { readSessionHistorySnapshotKernel } from "./session-history-snapshot.js";
import {
  readSessionHistorySnapshotAsync,
  SessionHistorySseState,
} from "./session-history-state.js";
import { createSessionHistorySubagentProjection } from "./session-history-subagent-projection.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";

const childKey = "agent:main:dashboard:spawned-worker";
const peerKey = "agent:main:dashboard:independent-peer";
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

async function withHistory(
  messages: Array<[string, Record<string, unknown>]>,
  run: (fixture: {
    scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
    entry: { sessionId: string; updatedAt: number };
    readers: ReturnType<typeof createReadonlySessionHistoryReader>;
    state: OpenClawTestState;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
      readers: createReadonlySessionHistoryReader({
        transcript: { ...scope, sessionFile: scope.sessionKey },
        database: { agentId: database.agentId, path: database.path },
        entryValidationKey: scope.sessionKey,
      }),
    });
  });
}

describe("subagent coordination history", () => {
  it("appends ordinary updates without probing session source paths", async () => {
    await withHistory(
      [["human-input", { role: "user", content: "Question", idempotencyKey: "human-run:user" }]],
      async ({ scope, entry, readers }) => {
        setRuntimeConfigSnapshot({ agents: { entries: { main: {}, other: {} } } });
        const snapshot = await readSessionHistorySnapshotKernel(
          { target: { ...scope, sessionEntry: entry } },
          { readers, readOnly: true },
        );
        const stat = vi.spyOn(fs, "lstatSync");
        const realpath = vi.spyOn(fs.realpathSync, "native");
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
            const result = history.appendInlineMessage({ message, messageSeq: 2 });
            if ("provenance" in message) {
              expect(result).toBeNull();
              expect(history.snapshot().messages).toEqual(snapshot.history.messages);
            } else {
              expect(result?.messageSeq).toBe(2);
              expect(history.snapshot().messages).toHaveLength(2);
            }
          }
          expect(stat).not.toHaveBeenCalled();
          expect(realpath).not.toHaveBeenCalled();
        } finally {
          stat.mockRestore();
          realpath.mockRestore();
        }
      },
    );
  });

  it("hides cross-agent dashboard coordination through worker history and local deltas", async () => {
    const sourceChild = "agent:worker:dashboard:child";
    const sourcePeer = "agent:worker:dashboard:peer";
    const forwarded = (runId: string, sourceSessionKey: string) => ({
      ...childInput(runId),
      provenance: { kind: "inter_session", sourceTool: "sessions_send", sourceSessionKey },
    });
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
      if (initial.kind !== "page") {
        throw new Error("Expected a current history cursor");
      }
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
        sse.appendInlineMessage({
          message: forwarded("cross-late-run", sourceChild),
          messageSeq: 5,
        }),
      ).toBeNull();
      expect(
        sse.appendInlineMessage({
          message: response("cross-late-run", "Later cross-agent acknowledgement"),
          messageSeq: 6,
        }),
      ).toBeNull();
      expect(sse.snapshot().messages).toEqual(page.history.messages);
      const delta = readChatHistoryDelta({
        agentId: scope.agentId,
        scope,
        sessionKey: scope.sessionKey,
        sessionSnapshot: {},
        cursor: initial.cursor,
      });
      expect.soft(delta).toMatchObject({ kind: "delta", messages: [] });
      const raw = await readers.readSessionMessagesAsync(scope, {
        mode: "full",
        reason: "raw cross-agent transcript proof",
      });
      expect(raw.map(readChatHistoryMessageId)).toEqual([
        ...messages.map(([id]) => id),
        "cross-late",
        "cross-late-answer",
      ]);
    });
  });

  it.each(
    [false, true].flatMap((deferSources) =>
      ["uncached-source", "cached-source", "cached-run", "projected-fast-path"].map((readKind) => ({
        readKind,
        deferSources,
      })),
    ),
  )(
    "rejects local history after shared-state retirement ($readKind, deferred=$deferSources)",
    async ({ readKind, deferSources }) => {
      await withHistory(
        [
          ["worker-input", childInput("worker-run")],
          ["worker-answer", response("worker-run", "Internal acknowledgement")],
        ],
        async ({ scope }) => {
          const database = openOpenClawStateDatabase();
          const subagentCoordination = createSessionHistorySubagentProjection(scope, {
            deferSources,
          });
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

  it.each([false, true])(
    "rejects plain projections after agent registration (deferred=%s)",
    async (deferSources) => {
      await withHistory([], async ({ scope }) => {
        const subagentCoordination = createSessionHistorySubagentProjection(scope, {
          deferSources,
        });
        openOpenClawAgentDatabase({ agentId: "registered-later" });
        expect(() =>
          projectChatDisplayMessages([{ role: "user", content: "Visible message" }], {
            subagentCoordination,
          }),
        ).toThrow("Session store changed");
      });
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
        [
          `acp-input-${index}`,
          {
            ...childInput(`acp-run-${index}`),
            provenance: {
              kind: "inter_session",
              sourceTool: "sessions_send",
              sourceSessionKey: key,
            },
          },
        ],
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
          if (!persisted) {
            throw new Error("Expected persisted ACP source session");
          }
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
            coordinatorRuntime: stateContext.coordinatorRuntime,
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
      [
        "removed-child-input",
        {
          ...childInput("removed-child-run"),
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: "agent:main:subagent:removed-child",
          },
        },
      ],
      ["removed-child-answer", response("removed-child-run", "Removed child acknowledgement")],
      [
        "peer-input",
        {
          ...childInput("peer-run"),
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: peerKey,
          },
        },
      ],
      ["peer-answer", response("peer-run", "Independent peer decision")],
      [
        "announce",
        {
          ...childInput("announce-run"),
          provenance: {
            kind: "inter_session",
            sourceTool: "subagent_announce",
            sourceSessionKey: childKey,
          },
        },
      ],
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
      [
        "missing-source",
        {
          ...childInput("missing-run"),
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: "agent:main:dashboard:missing",
          },
        },
      ],
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
      const raw = await readers.readSessionMessagesAsync(scope, {
        mode: "full",
        reason: "raw model transcript proof",
      });
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
        if (initial.kind !== "page") {
          throw new Error("Expected initial transcript cursor");
        }
        const later = {
          ...response("worker-run", "Another internal acknowledgement"),
          stopReason: "error",
          errorMessage: "Internal coordination failed",
        };
        await appendTranscriptMessage(scope, { eventId: "later", now: 2, message: later });
        expect(
          state.appendInlineMessage({ message: later, messageId: "later", messageSeq: 4 }),
        ).toBeNull();
        const delta = readChatHistoryDelta({
          agentId: scope.agentId,
          scope,
          sessionKey: scope.sessionKey,
          sessionSnapshot: {},
          cursor: initial.cursor,
        });
        expect(delta).toMatchObject({ kind: "delta", messages: [] });
        if (delta.kind !== "delta") {
          throw new Error("Expected hidden delta to advance its cursor");
        }
        await appendTranscriptMessage(scope, {
          eventId: "human-steer",
          now: 3,
          message: {
            role: "user",
            content: "Give me the remaining blockers.",
            idempotencyKey: "human-steer:user",
            __openclaw: { steerTargetRunId: "worker-run" },
          },
        });
        await appendTranscriptMessage(scope, {
          eventId: "human-answer",
          now: 4,
          message: response("worker-run", "The release still needs final validation."),
        });
        const resumed = readChatHistoryDelta({
          agentId: scope.agentId,
          scope,
          sessionKey: scope.sessionKey,
          sessionSnapshot: {},
          cursor: delta.deltaCursor,
        });
        expect(resumed).toMatchObject({
          kind: "delta",
          messages: [{ messageId: "human-steer" }, { messageId: "human-answer" }],
        });
        const freshReaders = createReadonlySessionHistoryReader({
          transcript: { ...scope, sessionFile: scope.sessionKey },
          database: { agentId: scope.agentId, path: scope.storePath },
          entryValidationKey: scope.sessionKey,
        });
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
