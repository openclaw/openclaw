import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
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
import {
  createTestProjection,
  watchRowFacts as observeRowFacts,
} from "./session-row-projection.read-fixture.test-support.js";
import { reportPlacementTransition } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());

function sessionDescriber(context: ReturnType<typeof requestContext>, key: string) {
  return async (expected: Record<string, unknown>) => {
    const respond = vi.fn();
    await sessionByKeyReadHandlers["sessions.describe"]!({
      req: { type: "req", id: "placement", method: "sessions.describe" },
      params: { key },
      client: null,
      context,
      isWebchatConnect: () => false,
      respond,
    });
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
      session: expect.objectContaining(expected),
    });
    return respond;
  };
}

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
    const read = sessionDescriber(context, target.sessionKey);
    const describe = (updatedAtMs: number) =>
      read({ placement: expect.objectContaining({ state: "local", updatedAtMs }) });
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
      const shared = createWorkerSessionPlacementStore({ database, now: () => nowMs });
      nowMs = 40;
      const sharedClaim = await shared.claimTurn(claimInput);
      await describe(40);
      expect(reads).not.toHaveBeenCalled();
      nowMs = 50;
      await shared.releaseTurn(sharedClaim);
      await describe(50);
      expect(reads).not.toHaveBeenCalled();
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
    setRuntimeConfigSnapshot(cfg);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:entry-placement",
      sessionId: "entry-placement",
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const placements = createWorkerSessionPlacementStore();
    await placements.startDispatch(target);
    using projection = await createTestProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const describe = sessionDescriber(context, target.sessionKey);
    const requested = expect.objectContaining({ state: "requested" });

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
      await describe({ sessionId: target.sessionId, placement: requested });
    }
    await updateSessionEntry(target, () => ({ label: "Updated by the entry worker" }));
    await describe({ label: "Updated by the entry worker", placement: requested });
    expect(reads).not.toHaveBeenCalled();

    const rowFactReads: string[][] = [];
    observeRowFacts((owner) => (input) => {
      rowFactReads.push([...input.sessionKeys]);
      return owner.readRowFacts(input);
    });
    const sharedReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    for (const [index, record] of [recordNativeParticipant, recordSessionParticipant].entries()) {
      const identity = { type: "agent" as const, id: `peer-${index}` };
      for (const promptedAt of [10, 20]) {
        rowFactReads.length = 0;
        sharedReads.mockClear();
        expect(await record(target, { identity, promptedAt })).toBe(
          promptedAt === 10 ? "inserted" : "updated",
        );
        await describe({
          participantCount: index + 1,
          participants: expect.arrayContaining(
            Array.from({ length: index + 1 }, (_, peer) =>
              expect.objectContaining({ identity: { type: "agent", id: `peer-${peer}` } }),
            ),
          ),
          placement: requested,
        });
        if (record === recordSessionParticipant) {
          expect(rowFactReads).toEqual([]);
          expect(
            sharedReads.mock.calls.filter(
              ([, command]) => command.type === "sessionRows.sharedFacts",
            ),
          ).toEqual([]);
        }
      }
    }
    expect(reads).not.toHaveBeenCalled();

    emitSessionLifecycleEvent({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      reason: "worker-runtime-install",
      scope: "runtime",
    });
    await describe({ label: "Updated by the entry worker", placement: requested });
    expect(reads).not.toHaveBeenCalled();

    sessionChanges.emit({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      factsInvalidated: true,
    });
    await describe({ placement: requested });
    expect(reads).toHaveBeenCalled();
    reads.mockClear();

    reportPlacementTransition(
      undefined,
      await placements.fail({ sessionId: target.sessionId, recoveryError: "Worker stopped" }),
    );
    await describe({
      placement: expect.objectContaining({ state: "failed", recoveryError: "Worker stopped" }),
    });
    expect(reads).toHaveBeenCalled();

    replaceSessionEntrySync(target, { sessionId: "replacement-session", updatedAt: 2 });
    const respond = await describe({ sessionId: "replacement-session" });
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("session.placement");
  });
});
