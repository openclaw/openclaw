import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { SessionWorkerPlacementContext } from "../../gateway/session-worker-placement-context.js";
import { matchesWorkerPlacementTarget } from "../../gateway/worker-environments/placement-target.js";

/** Read admission facts without treating same-destination claim settlement as revocation. */
export async function readReplyAdmissionSession(params: {
  sessionId: string;
  placementContext?: SessionWorkerPlacementContext;
  readEntry: () => Promise<SessionEntry | undefined>;
  assertCurrent: () => void;
}): Promise<{ entry: SessionEntry; stagedWorkerInput: boolean }> {
  const { sessionId, placementContext } = params;
  const placementService = placementContext?.workerSessionPlacementService;
  if (placementService && !placementService.prepareSessionPlacement) {
    throw new Error("Worker placement observation service is unavailable");
  }
  const placement = placementService?.prepareSessionPlacement
    ? await placementService.prepareSessionPlacement(sessionId)
    : undefined;
  try {
    const initialRead = placement?.prepareRead();
    if (initialRead) {
      await initialRead;
    }
    const initialPlacement = placement?.current();
    const assertCurrent = () => {
      params.assertCurrent();
      if (placementContext?.workerSessionPlacementService !== placementService) {
        throw new Error("Worker placement service changed before durable user-turn admission");
      }
      const currentPlacement = placement?.current();
      if (
        !matchesWorkerPlacementTarget(currentPlacement, initialPlacement) ||
        currentPlacement?.agentId !== initialPlacement?.agentId ||
        currentPlacement?.sessionKey !== initialPlacement?.sessionKey ||
        currentPlacement?.executionMode !== initialPlacement?.executionMode
      ) {
        throw new Error(`Session ${sessionId} placement authority changed`);
      }
    };
    let entry: SessionEntry | undefined;
    for (;;) {
      try {
        entry = await params.readEntry();
      } catch (error) {
        assertCurrent();
        throw error;
      }
      const pendingRead = placement?.prepareRead();
      if (!pendingRead) {
        break;
      }
      // Claim settlement may outlive session facts; reacquire both before admission.
      await pendingRead;
    }
    assertCurrent();
    if (!entry || entry.sessionId !== sessionId) {
      throw new Error("session changed before durable user-turn admission");
    }
    return {
      entry,
      stagedWorkerInput: Boolean(initialPlacement && initialPlacement.state !== "local"),
    };
  } finally {
    // This selects input custody; the execution claim writer owns its later guards.
    placement?.release();
  }
}
