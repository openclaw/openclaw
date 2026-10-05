import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  invokeSessionReclaim,
  makeReclaimedPlacement as reclaimedPlacementRecord,
} from "./sessions-dispatch.test-support.js";
import type { GatewayRequestContext } from "./types.js";

export function registerSessionReclaimCases(input: {
  useWorktreeSession: () => void;
  reclaimActivePlacement: () => WorkerSessionPlacementRecord;
  reclaimContext: (
    placement: () => WorkerSessionPlacementRecord,
    reclaim: NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["reclaim"],
    overrides?: Partial<GatewayRequestContext>,
  ) => GatewayRequestContext;
  expectReclaimed: (respond: unknown, state?: string) => void;
}) {
  const { useWorktreeSession, reclaimActivePlacement, reclaimContext, expectReclaimed } = input;
  describe("sessions.reclaim", () => {
    beforeEach(() => useWorktreeSession());
    it("returns an unchanged reclaimed placement without publishing a change", async () => {
      const reclaimed = reclaimedPlacementRecord();
      const reclaim = vi.fn().mockResolvedValue(reclaimed);
      const context = reclaimContext(() => reclaimed, reclaim);
      const changes = vi.fn();
      onTestFinished(sessionChanges.subscribe(changes));
      const respond = await invokeSessionReclaim(context);

      expect(reclaim).toHaveBeenCalledWith(
        {
          sessionId,
          sessionKey,
          agentId: "main",
        },
        undefined,
      );
      expectReclaimed(respond);
      expect(changes).not.toHaveBeenCalled();
    });

    it("delegates a failed placement's local recovery to the reclaim owner", async () => {
      const failed = {
        ...reclaimedPlacementRecord(),
        state: "failed",
        environmentId: null,
        activeOwnerEpoch: null,
        workspaceBaseManifestRef: null,
        remoteWorkspaceDir: null,
        workerBundleHash: null,
        recoveryError: "device worker is offline",
        terminalReason: "device worker is offline",
      } as WorkerSessionPlacementRecord;
      const local = {
        ...failed,
        state: "local",
        generation: failed.generation + 1,
        recoveryError: null,
        terminalReason: null,
        terminalAtMs: null,
      } as WorkerSessionPlacementRecord;
      const reclaim = vi.fn().mockResolvedValue(local);
      const recovery = { recoverToGateway: { expectedGeneration: failed.generation } };
      const respond = await invokeSessionReclaim(
        reclaimContext(() => failed, reclaim),
        undefined,
        recovery,
      );

      expect(reclaim).toHaveBeenCalledExactlyOnceWith(
        {
          sessionId,
          sessionKey,
          agentId: "main",
          ...recovery,
        },
        undefined,
      );
      expectReclaimed(respond, "local");
    });

    it("does not let session change reporting failure replace a committed reclaim", async () => {
      const context = reclaimContext(
        reclaimActivePlacement,
        vi.fn().mockResolvedValue(reclaimedPlacementRecord()),
        {
          getSessionEventSubscriberConnIds: () => {
            throw new Error("session subscribers unavailable");
          },
        },
      );

      const changes = vi.fn();
      onTestFinished(sessionChanges.subscribe(changes));
      const respond = await invokeSessionReclaim(context);

      expectReclaimed(respond);
      expect(changes).toHaveBeenCalledExactlyOnceWith({ sessionKey });
    });

    it.each(["success", "persisted failure"] as const)(
      "publishes a %s placement change to another session subscriber",
      async (outcome) => {
        await withOpenClawTestState({ scenario: "minimal" }, async () => {
          let placement = reclaimActivePlacement();
          const reclaimError = new Error("worker teardown failed after committing placement");
          const reclaim = vi.fn(async () => {
            if (outcome === "persisted failure") {
              placement = {
                ...placement,
                state: "failed",
                generation: placement.generation + 1,
                updatedAtMs: placement.updatedAtMs + 1,
                recoveryError: reclaimError.message,
              } as WorkerSessionPlacementRecord;
              throw reclaimError;
            }
            placement = reclaimedPlacementRecord();
            return placement;
          });
          const context = reclaimContext(() => placement, reclaim, {
            broadcastToConnIds: vi.fn(),
            chatAbortControllers: new Map(),
            getSessionEventSubscriberConnIds: () => new Set(["another-client"]),
          });

          try {
            const changes = vi.fn();
            onTestFinished(sessionChanges.subscribe(changes));
            const respond = await invokeSessionReclaim(context);

            expect(respond).toHaveBeenCalledWith(
              outcome === "success",
              outcome === "success" ? expect.objectContaining({ ok: true }) : undefined,
              outcome === "success"
                ? undefined
                : expect.objectContaining({ message: reclaimError.message }),
            );
            await flushPendingSessionsChangedEvents(context);
            expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
              "sessions.changed",
              expect.objectContaining({ reason: "reclaim", sessionKey }),
              new Set(["another-client"]),
              expect.objectContaining({ agentId: "main", dropIfSlow: true }),
            );
            expect(changes).toHaveBeenCalledExactlyOnceWith({ sessionKey });
          } finally {
            await flushPendingSessionsChangedEvents(context);
          }
        });
      },
    );
  });
}
