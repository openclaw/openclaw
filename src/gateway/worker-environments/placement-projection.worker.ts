import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import { readWorkerSessionPlacementProjectionInDatabase } from "./placement-read-projection.js";

export const placementProjectionOperations = {
  "workerPlacements.readWithMove": (
    input: { sessionId: string },
    { open }: WorkerOperationContext,
  ) => {
    const { projection } = readWorkerSessionPlacementProjectionInDatabase(
      open().db,
      [input.sessionId],
      [],
    );
    return {
      placement: projection.placements.get(input.sessionId),
      move: projection.moves.get(input.sessionId),
    };
  },
} satisfies WorkerOperationHandlers;
