import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { SessionWorkerPlacementContext } from "../../gateway/session-worker-placement-context.js";

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
    const entry = await params.readEntry();
    params.assertCurrent();
    const currentPlacement = placement?.current();
    if (!entry || entry.sessionId !== sessionId) {
      throw new Error("session changed before durable user-turn admission");
    }
    return {
      entry,
      stagedWorkerInput: Boolean(currentPlacement && currentPlacement.state !== "local"),
    };
  } finally {
    // This selects input custody; the execution claim writer owns its later guards.
    placement?.release();
  }
}
