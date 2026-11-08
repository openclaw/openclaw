import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendSessionManagerActor } from "../agents/sessions/session-manager-actor-append.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { bindSessionTranscriptStoreScope } from "../config/sessions/session-accessor.transcript-target.js";
import { withSessionActor } from "../config/sessions/session-actor-scope.js";
import {
  runSessionColdStorageMaintenance,
  restoreSessionColdTranscript,
} from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { buildRestartRecoveryExpectedState } from "../config/sessions/session-transcript-turn-state.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { patchSessionEntry as patchSdkSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { serializeGatewayFrame } from "./serialized-json.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { RespondFn } from "./server-methods/types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";
import type { SessionsListResult } from "./session-utils.types.js";

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

it("publishes completed usage immediately after cold restoration to warmed list pages", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    const cfg = maintenanceConfig(storePath);
    setRuntimeConfigSnapshot(cfg);
    const fixture = await createSessionColdStorageFixture(storePath);
    expect(await runSessionColdStorageMaintenance({ config: cfg })).toEqual({
      archivedTranscripts: 1,
      externalizedTranscripts: 0,
    });
    replaceSessionEntrySync(fixture.scope, {
      sessionId: historicalId,
      updatedAt: 1,
      lifecycleRevision: "selected",
    });
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const list = async (acceptsSerializedJson: boolean) => {
      const respond = vi.fn<RespondFn>();
      await sessionReadHandlers["sessions.list"]!({
        req: { type: "req", id: "cold-usage-list", method: "sessions.list" },
        params: { agentId: "main", archived: "all", limit: 20 },
        acceptsSerializedJson,
        client: null,
        context,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      const payload = respond.mock.calls[0]?.[1] as SessionsListResult;
      if (!acceptsSerializedJson) {
        return payload;
      }
      // Exercise the registered cached row bytes, not just their parallel object view.
      const frame = serializeGatewayFrame({
        type: "res",
        id: "cold-usage-list",
        ok: true,
        payload,
      });
      expect(Buffer.isBuffer(frame)).toBe(true);
      const decoded = JSON.parse(frame.toString()) as { payload: SessionsListResult };
      return decoded.payload;
    };
    try {
      // Populate the resident row and serialized page before the restore/commit.
      const warmed = (await list(true)).sessions[0];
      expect(warmed).toMatchObject({ sessionId: historicalId });
      await restoreSessionColdTranscript(fixture.scope);
      const authority = { assertCurrent() {}, authorize() {} };
      await withSessionActor(
        fixture.scope,
        { assertCurrent() {}, assertReadable() {} },
        async (actor) => {
          const before = await actor.read(authority);
          const usage = {
            input: 100,
            output: 20,
            total: 120,
            usageReport: { state: "available" as const },
          };
          const completed = await actor.completeTurn(
            {
              commandId: "cold-usage-complete",
              phaseId: "complete:cold-usage",
              expected: before.version,
              bookkeeping: {
                sessionId: historicalId,
                lifecycleRevision: "selected",
                writerRunId: undefined,
                expectedState: buildRestartRecoveryExpectedState(before.entry!),
              },
              reducers: [
                {
                  kind: "usage",
                  updatedAt: 2,
                  update: {
                    usage,
                    lastCallUsage: usage,
                    modelSelection: { provider: "openai", model: "synthetic" },
                    hasContextUpdate: true,
                    hasFreshContextSnapshot: true,
                    hasCurrentContextSnapshot: false,
                    preserveSessionModelState: false,
                    preserveUserFacingRunState: false,
                  },
                },
              ],
            },
            authority,
          );
          expect(completed.kind).toBe("committed");
          if (completed.kind !== "committed") {
            throw new Error("Usage did not commit");
          }
          expect(completed.failure).toBeUndefined();
          expect(completed.receipt.postimage.entry).toMatchObject({
            inputTokens: 100,
            outputTokens: 20,
          });
          // No polling, explicit materialization, flush, or publication injection after commit.
          const serialized = (await list(true)).sessions[0];
          const ordinary = (await list(false)).sessions[0];
          for (const row of [serialized, ordinary]) {
            expect(row).toMatchObject({
              key: fixture.scope.sessionKey,
              sessionId: historicalId,
              inputTokens: 100,
              outputTokens: 20,
              usageReport: { state: "available" },
            });
          }
        },
      );
    } finally {
      projection.dispose();
      release();
    }
  });
});
