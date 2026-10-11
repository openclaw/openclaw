import { afterEach, expect, it, vi } from "vitest";
import { updateSessionEntry } from "../config/sessions/session-accessor.entry-mutation.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { recordSessionParticipant as recordNativeParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { recordSessionParticipantInWorker as recordSessionParticipant } from "../config/sessions/session-sharing-store.async.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { reportPlacementTransition } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createPlacementTurnClaimFixtureOps } from "./worker-environments/placement-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

it("publishes local placement receipts without rereading or adopting another store's facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    const target = {
      agentId: "main",
      sessionKey: "agent:main:local-placement-receipt",
      sessionId: "local-placement-receipt",
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const database = openOpenClawStateDatabase();
    let nowMs = 10;
    const placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const describe = async (updatedAtMs: number) => {
      const respond = vi.fn();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "placement-receipt", method: "sessions.describe" },
        params: { key: target.sessionKey },
        client: null,
        context,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          placement: expect.objectContaining({ state: "local", updatedAtMs }),
        }),
      });
    };
    const claimInput = {
      ...target,
      claimId: "receipt-claim",
      runId: "receipt-run",
      owner: { kind: "local" as const },
    };
    const resumeRead = createDeferredCore();
    try {
      await projection.ensureMaterialized();
      const readProjection = placements.readProjection.bind(placements);
      const reads = vi.spyOn(placements, "readProjection");
      const rowReads = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
      const metadataReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      const claim = await placements.claimTurn(claimInput);
      await describe(10);
      nowMs = 20;
      await placements.releaseTurn(claim);
      await describe(20);
      expect(reads).not.toHaveBeenCalled();
      expect(rowReads).not.toHaveBeenCalled();
      expect(
        metadataReads.mock.calls.filter(
          ([, command]) => command.type === "sessionRows.sharedFacts",
        ),
      ).toEqual([]);

      const reading = createDeferredCore();
      reads.mockImplementationOnce(async (...args) => {
        const snapshot = await readProjection(...args);
        reading.resolve();
        await resumeRead.promise;
        return snapshot;
      });
      sessionChanges.emit(target);
      await reading.promise;
      nowMs = 30;
      const next = await placements.claimTurn({ ...claimInput, claimId: "next-receipt-claim" });
      resumeRead.resolve();
      await describe(30);
      expect(reads).toHaveBeenCalledTimes(1);
      await placements.releaseTurn(next);

      reads.mockClear();
      const other = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ path: state.statePath("other-state.sqlite") }),
        now: () => 99,
      });
      const otherClaim = await other.claimTurn(claimInput);
      await describe(30);
      expect(reads).toHaveBeenCalled();
      await other.releaseTurn(otherClaim);
      await projection.ensureMaterialized();

      reads.mockClear();
      const native = createPlacementTurnClaimFixtureOps(database);
      const nativeClaim = native.claimTurn(claimInput);
      await describe(placements.get(target.sessionId)!.updatedAtMs);
      expect(reads).toHaveBeenCalled();
      native.releaseTurn(nativeClaim);
    } finally {
      resumeRead.resolve();
      projection.dispose();
    }
  });
});

it("reuses placement after runtime events and entry writes and refreshes actual placement changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        entries: { main: {} },
        defaults: { model: "unit-test/model", utilityModel: "" },
      },
    };
    const target = {
      agentId: "main",
      sessionKey: "agent:main:entry-placement",
      sessionId: "entry-placement",
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const placements = createWorkerSessionPlacementStore();
    await placements.startDispatch(target);
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const respond = vi.fn();
    const describe = async () => {
      respond.mockClear();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "entry-placement", method: "sessions.describe" },
        params: { key: target.sessionKey },
        client: null,
        context,
        isWebchatConnect: () => false,
        respond,
      });
    };
    try {
      await projection.ensureMaterialized();
      const reads = vi.spyOn(placements, "readProjection");
      for (let index = 0; index < 3; index++) {
        await persistSessionTranscriptTurn(target, {
          messages: [
            {
              eventId: `entry-message-${index}`,
              message: { role: "user", content: `Message ${index}` },
            },
          ],
          touchSessionEntry: true,
        });
        await describe();
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          session: expect.objectContaining({
            sessionId: target.sessionId,
            placement: expect.objectContaining({ state: "requested" }),
          }),
        });
      }
      await updateSessionEntry(target, () => ({ label: "Updated by the entry worker" }));
      await describe();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          label: "Updated by the entry worker",
          placement: expect.objectContaining({ state: "requested" }),
        }),
      });
      expect(reads).not.toHaveBeenCalled();

      for (const [index, record] of [recordNativeParticipant, recordSessionParticipant].entries()) {
        const identity = { type: "agent" as const, id: `peer-${index}` };
        for (const promptedAt of [10, 20]) {
          expect(await record(target, { identity, promptedAt })).toBe(
            promptedAt === 10 ? "inserted" : "updated",
          );
          await describe();
          expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
            session: expect.objectContaining({
              participantCount: index + 1,
              participants: expect.arrayContaining([expect.objectContaining({ identity })]),
              placement: expect.objectContaining({ state: "requested" }),
            }),
          });
        }
      }
      expect(reads).not.toHaveBeenCalled();

      emitSessionLifecycleEvent({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        reason: "worker-runtime-install",
        scope: "runtime",
      });
      await describe();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          label: "Updated by the entry worker",
          placement: expect.objectContaining({ state: "requested" }),
        }),
      });
      expect(reads).not.toHaveBeenCalled();

      sessionChanges.emit({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        factsInvalidated: true,
      });
      await describe();
      expect(reads).toHaveBeenCalled();
      reads.mockClear();

      reportPlacementTransition(
        undefined,
        await placements.fail({ sessionId: target.sessionId, recoveryError: "Worker stopped" }),
      );
      await describe();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          placement: expect.objectContaining({ state: "failed", recoveryError: "Worker stopped" }),
        }),
      });
      expect(reads).toHaveBeenCalled();

      replaceSessionEntrySync(target, { sessionId: "replacement-session", updatedAt: 2 });
      await describe();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          sessionId: "replacement-session",
        }),
      });
      expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("session.placement");
    } finally {
      projection.dispose();
    }
  });
});
