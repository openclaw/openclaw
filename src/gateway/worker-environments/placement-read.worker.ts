import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import { readWorkerPlacementMovesReadOnly } from "./placement-move-row-codec.js";
import {
  readWorkerPlacementIdentitiesInDatabase,
  readWorkerPlacementsInDatabase,
  readWorkerPlacementsForReconcileInDatabase,
} from "./placement-row-codec.js";

export const placementReadOperations = {
  "workerPlacements.readIdentities": (
    _input: Record<string, never>,
    { open }: WorkerOperationContext,
  ) => readWorkerPlacementIdentitiesInDatabase(open().db),
  "workerPlacements.read": (
    input: { sessionIds?: readonly string[] },
    { open }: WorkerOperationContext,
  ) => readWorkerPlacementsInDatabase(open().db, input.sessionIds),
  "workerPlacements.readMove": (input: { sessionId: string }, { open }: WorkerOperationContext) =>
    readWorkerPlacementMovesReadOnly(open().db, [input.sessionId]).get(input.sessionId),
  "workerPlacements.readReconcile": (
    input: { sessionKey?: string },
    { open }: WorkerOperationContext,
  ) => readWorkerPlacementsForReconcileInDatabase(open().db, input.sessionKey),
} satisfies WorkerOperationHandlers;
