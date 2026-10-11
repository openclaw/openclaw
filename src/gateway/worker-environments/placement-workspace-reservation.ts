import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { matchesWorkerPlacementTarget } from "./placement-target.js";
import {
  PERSONAL_SCOPE,
  readWorkspaceReservationAuthority,
  SessionWorkspaceReservationBusyError,
} from "./placement-workspace-reservation.kernel.js";

const SCOPE = "session-workspace-action";
function assertReconciled(
  facts: ReturnType<typeof readWorkspaceReservationAuthority>,
  identity: WorkerSessionPlacementIdentity,
  workspace: "local" | "repository",
): void {
  const { placement, pending, reconciling } = facts;
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

export function createPlacementWorkspaceReservationOps(runtime: PlacementStoreRuntime) {
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
          const initial = readWorkspaceReservationAuthority(runtime.read(), identity.sessionId);
          assertReconciled(initial, identity, workspace);
          const assertCurrent = () => {
            assertPublisherExclusion();
            assertOwned();
            const current = readWorkspaceReservationAuthority(runtime.read(), identity.sessionId);
            assertReconciled(current, identity, workspace);
            if (!matchesWorkerPlacementTarget(current.placement, initial.placement)) {
              throw new Error("The session workspace placement changed during publication.");
            }
          };
          // This lease is exclusion only: it never creates a model run, turn claim, or identity.
          return await run(assertCurrent);
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
