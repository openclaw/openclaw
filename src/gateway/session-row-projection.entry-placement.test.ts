import { afterEach, expect, it, vi } from "vitest";
import { updateSessionEntry } from "../config/sessions/session-accessor.entry-mutation.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.js";
import { recordSessionParticipant as recordNativeParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { reportPlacementTransition } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "./worker-environments/placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";
import { failHandedOffTurn } from "./worker-environments/worker-turn-failure.js";

afterEach(() => vi.restoreAllMocks());

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

it("publishes failed placement after asynchronous handed-off turn cleanup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { defaults: { model: "unit-test/model", utilityModel: "" } } };
    const target = {
      agentId: "main",
      sessionKey: "agent:main:failed-placement-publication",
      sessionId: "failed-placement-publication",
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const active = await advancePlacementFixtureToActive(placements, database, target);
    const environments = await createWorkerEnvironmentStore({ database });
    const environment = environments.get(active.environmentId);
    if (environment?.state !== "attached") {
      throw new Error("Expected the seeded attached worker environment");
    }
    const environmentView = {
      ...environment,
      desktopAvailable: false,
      desktopApps: [],
      tunnelStatus: "stopped" as const,
    };
    const claim = await placements.claimTurn({
      ...target,
      claimId: "failed-placement-claim",
      runId: "failed-placement-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
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
        req: { type: "req", id: "failed-placement", method: "sessions.describe" },
        params: { key: target.sessionKey },
        client: null,
        context,
        isWebchatConnect: () => false,
        respond,
      });
    };
    const stopping = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const unused = () => {
      throw new Error("Unexpected environment operation");
    };
    await projection.ensureMaterialized();
    const cleanup = failHandedOffTurn({
      environments: {
        get: () => environmentView,
        acknowledgeCredentialDelivery: unused,
        acquireTurnCredential: unused,
        startTunnel: unused,
        stopTunnel: async () => {
          stopping.resolve();
          await stopped.promise;
        },
        destroy: async () => ({ ...environmentView, state: "destroyed" as const }),
      },
      placements,
      placement: active,
      turnClaim: claim,
      error: new Error("node cancellation acknowledgement lost"),
    });
    try {
      await stopping.promise;
      await describe();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          placement: expect.objectContaining({ state: "draining" }),
        }),
      });
      stopped.resolve();
      await cleanup;
      expect(placements.get(target.sessionId)).toMatchObject({ state: "failed", turnClaim: null });
      await describe();
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[1]?.session?.placement?.state).toBe("failed");
    } finally {
      stopped.resolve();
      await cleanup;
      projection.dispose();
    }
  });
});
