import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendSessionManagerActor } from "../agents/sessions/session-manager-actor-append.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { bindSessionTranscriptStoreScope } from "../config/sessions/session-accessor.transcript-target.js";
import { withSessionActor } from "../config/sessions/session-actor-scope.js";
import { buildRestartRecoveryExpectedState } from "../config/sessions/session-transcript-turn-state.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { patchSessionEntry as patchSdkSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function observeRowFacts(
  wrap: (
    owner: history.SessionHistoryWorkerDatabase,
  ) => history.SessionHistoryWorkerDatabase["readRowFacts"],
  once = false,
) {
  const readDatabases = history.withSessionHistoryWorkerDatabases;
  const observe: typeof readDatabases = (databases, consume, lane) =>
    readDatabases(
      databases,
      (owners) =>
        consume(
          owners.map((owner) => ({
            ...owner,
            readRowFacts: wrap(owner),
          })),
        ),
      lane,
    );
  const spy = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
  return once ? spy.mockImplementationOnce(observe) : spy.mockImplementation(observe);
}

it("reuses actor row facts after metadata writes and refreshes Board presence after a write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const scope = { agentId: "main", sessionKey: "agent:main:actor-row-facts" };
    const entry = {
      sessionId: "actor-row-facts",
      lifecycleRevision: "actor-row-lifecycle",
      updatedAt: 1,
      label: "Initial",
      skillsSnapshot: { prompt: "Saved actor instructions", skills: [] },
    };
    replaceSessionEntrySync(scope, entry);
    const authority = { assertCurrent() {}, authorize() {} };
    const exercised = await withSessionActor(
      scope,
      { assertCurrent() {}, assertReadable() {} },
      async (actor) => {
        await actor.read(authority);
        const updateLabel = (label: string, updatedAt: number) =>
          patchSdkSessionEntry({
            ...scope,
            skipMaintenance: true,
            update: () => ({ updatedAt, label }),
          });
        await updateLabel("Committed metadata", 2);
        const reads: string[][] = [];
        observeRowFacts((owner) => (input) => {
          reads.push([...input.sessionKeys]);
          return owner.readRowFacts(input);
        });
        const release = retainSessionListForegroundWork();
        const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        const query = { agentId: scope.agentId, key: scope.sessionKey };
        try {
          await projection.ensureMaterialized();
          expect(projection.snapshot(query).row).toMatchObject({
            sessionId: entry.sessionId,
            label: "Committed metadata",
            hasBoard: false,
          });
          expect(projection.describe(query)?.retainedDatabaseFacts?.entry).not.toHaveProperty(
            "skillsSnapshot",
          );
          expect(reads).toEqual([]);

          const board = new SqliteBoardStore({
            resolveSession: ({ sessionKey }) => ({ agentId: scope.agentId, sessionKey }),
          });
          await board.putWidget({
            sessionKey: scope.sessionKey,
            name: "status",
            content: { kind: "html", html: "<p>Current</p>" },
          });
          await projection.ensureMaterialized();
          expect(projection.snapshot(query).row).toMatchObject({
            hasBoard: true,
            label: "Committed metadata",
          });
          expect(reads).toEqual([[scope.sessionKey]]);
          await updateLabel("Metadata after Board", 3);
          await projection.ensureMaterialized();
          expect(projection.snapshot(query).row).toMatchObject({
            hasBoard: true,
            label: "Metadata after Board",
          });
          expect(reads).toEqual([[scope.sessionKey]]);
        } finally {
          projection.dispose();
          release();
        }
        return true;
      },
    );
    expect(exercised).toBe(true);
  });
});

it("publishes user and assistant actor previews without background reads or losing the replica", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const scope = { agentId: "main", sessionKey: "agent:main:actor-preview" };
    const entry = {
      sessionId: "actor-preview",
      lifecycleRevision: "actor-preview-lifecycle",
      updatedAt: 1,
    };
    replaceSessionEntrySync(scope, entry);
    const authority = { assertCurrent() {}, authorize() {} };
    const exercised = await withSessionActor(
      scope,
      { assertCurrent() {}, assertReadable() {} },
      async (actor) => {
        await actor.read(authority);
        const reads: string[][] = [];
        observeRowFacts((owner) => (input) => {
          reads.push([...input.sessionKeys]);
          return owner.readRowFacts(input);
        });
        const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
        const release = retainSessionListForegroundWork();
        const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        const query = { agentId: scope.agentId, key: scope.sessionKey };
        try {
          await projection.ensureMaterialized();
          const input = await actor.acceptInput(
            {
              commandId: "accepted-input",
              phaseId: "turn",
              expectedState: buildRestartRecoveryExpectedState(entry),
              lifecycle: {},
              turn: {
                ...scope,
                options: {
                  expectedSessionId: entry.sessionId,
                  sessionFile: "synthetic.jsonl",
                  touchSessionEntry: false,
                  messages: [
                    {
                      eventId: "accepted-input",
                      message: { role: "user", content: "Accepted question" },
                      now: 2,
                    },
                  ],
                },
              },
            },
            authority,
          );
          expect(input.kind).toBe("committed");
          await projection.ensureMaterialized();
          expect(
            projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview,
          ).toBe("Accepted question");
          expect(actor.snapshot(authority)?.transcript).toMatchObject({
            anchorsState: "unavailable",
            projection: { state: { activeMessageCount: 1 } },
          });

          const reply = await appendSessionManagerActor({
            actor,
            toolResult: false,
            assertCurrent() {},
            append: {
              kind: "message",
              input: {
                scope: bindSessionTranscriptStoreScope(
                  { ...scope, sessionId: entry.sessionId },
                  cfg,
                ),
                cwd: "/synthetic",
                messageJson: JSON.stringify({
                  role: "assistant",
                  content: "Committed answer",
                  timestamp: 3,
                }),
              },
            },
          });
          expect(reply.failure).toBeUndefined();
          await projection.ensureMaterialized();
          expect(
            projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview,
          ).toBe("Committed answer");
          expect(actor.snapshot(authority)?.transcript).toMatchObject({
            anchorsState: "unavailable",
            projection: { state: { activeMessageCount: 2 } },
          });
          expect(reads).toEqual([]);

          release();
          await nextTurn();
          expect(backfill).not.toHaveBeenCalled();
        } finally {
          projection.dispose();
          release();
        }
        return true;
      },
    );
    expect(exercised).toBe(true);
  });
});
