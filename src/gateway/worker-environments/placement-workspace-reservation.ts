import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import { preparePlacementAuthorityRead } from "./placement-turn-authority.js";
import {
  PERSONAL_SCOPE,
  SessionWorkspaceReservationBusyError,
} from "./placement-workspace-reservation.kernel.js";

const SCOPE = "session-workspace-action";
function assertReconciled(
  facts: WorkerSessionPlacementProjection,
  identity: WorkerSessionPlacementIdentity,
  workspace: "local" | "repository",
): void {
  const placement = facts.placements.get(identity.sessionId);
  const pending = facts.pendingResults.has(identity.sessionId);
  const reconciling = facts.workspaceJournalOwnerSessionIds.has(identity.sessionId);
  if (
    placement &&
    (placement.agentId !== identity.agentId || placement.sessionKey !== identity.sessionKey)
  ) {
    throw new Error("The session workspace placement identity changed.");
  }
  if (
    placement &&
    ((placement.state !== "local" &&
      placement.state !== "reclaimed" &&
      !(
        workspace === "repository" &&
        (placement.state === "active" || placement.state === "failed")
      )) ||
      placement.turnClaim)
  ) {
    throw new SessionWorkspaceReservationBusyError(
      workspace === "repository"
        ? "The repository checkpoint is busy; finish the current turn or worker operation before publishing."
        : "My GitHub publication requires an idle local workspace; finish the turn and reclaim remote work first.",
    );
  }
  if (pending || reconciling) {
    throw new SessionWorkspaceReservationBusyError(
      "The session workspace is still reconciling; wait for reclaim to finish before publishing with My GitHub.",
    );
  }
}

export function createPlacementWorkspaceReservationOps(
  runtime: { path: string },
  read: (sessionId: string) => Promise<WorkerSessionPlacementProjection>,
) {
  const signal = getGatewayRestartDrainSignal();
  const withReservation = async <T>(
    scope: string,
    sessionId: string,
    run: (assertOwned: () => void) => Promise<T>,
  ): Promise<T> =>
    await withOpenClawStateLease(
      {
        scope,
        key: sessionId,
        database: { scope: "shared", options: { path: runtime.path } },
        leaseMs: 60000,
        waitMs: 0,
        leaseLabel: "session publication exclusion",
        signal,
      },
      async (lease) => await run(() => lease.assertOwned()),
    );
  const withWorkspaceExclusion = <T>(
    sessionId: string,
    run: (assertOwned: () => void) => Promise<T>,
  ) => withReservation(SCOPE, sessionId, run);
  const withWorkspaceReservation = async <T>(
    identity: WorkerSessionPlacementIdentity,
    workspace: "local" | "repository",
    run: (assertCurrent: () => void) => Promise<T>,
  ): Promise<T> => {
    return await withWorkspaceExclusion(
      identity.sessionId,
      async (assertPublisherExclusion) =>
        await withReservation(PERSONAL_SCOPE, identity.sessionId, async (assertOwned) => {
          const prepared = await preparePlacementAuthorityRead(
            runtime.path,
            identity.sessionId,
            () => read(identity.sessionId),
          );
          try {
            assertReconciled(prepared.value, identity, workspace);
            const assertCurrent = () => {
              assertPublisherExclusion();
              assertOwned();
              prepared.assertCurrent();
            };
            // Exclusion blocks new claims; committed placement changes revoke the prepared facts.
            return await run(assertCurrent);
          } finally {
            prepared.release();
          }
        }),
    );
  };
  return {
    withWorkspaceExclusion,
    withLocalWorkspaceReservation: <T>(
      identity: WorkerSessionPlacementIdentity,
      run: (assertCurrent: () => void) => Promise<T>,
    ) => withWorkspaceReservation(identity, "local", run),
    withRepositoryWorkspaceReservation: <T>(
      identity: WorkerSessionPlacementIdentity,
      run: (assertCurrent: () => void) => Promise<T>,
    ) => withWorkspaceReservation(identity, "repository", run),
  };
}
