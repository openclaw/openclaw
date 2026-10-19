import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { REQUEST, type PlacementStore } from "./placement-dispatch-test-fixtures.js";
import { placementTurnOwner, type WorkerSessionPlacementRecord } from "./placement-record.js";

type ActivePlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;
export const WORKER_PROTOCOL_FEATURES = [
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
] as const;
export const workerBundle = (
  artifact: typeof import("./service.test-support.js").BUNDLE_ARTIFACT,
) => ({
  ...artifact,
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
});

export function makeClaimInput(
  active: Parameters<typeof placementTurnOwner>[0],
  claimId: string,
  runId = claimId,
) {
  return { ...REQUEST, claimId, runId, owner: placementTurnOwner(active) };
}

export function expectPlacement(
  store: Pick<PlacementStore, "get">,
  state: WorkerSessionPlacementRecord["state"],
  fields: Record<string, unknown> = {},
) {
  expect(store.get(REQUEST.sessionId)).toMatchObject({ state, ...fields });
}

export async function seedReconciliationJournal(
  store: PlacementStore,
  active: ActivePlacement,
  currentManifestRef: string,
  nonce = "a",
) {
  const owner = {
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    placementGeneration: active.generation,
  };
  await store.beginWorkspaceReconciliation(owner, {
    version: 1,
    temporaryNonce: nonce.repeat(32),
    baseManifestRef: active.workspaceBaseManifestRef,
    currentManifestRef,
    baseEntries: [],
    appliedEntries: [],
    baseTree: "f".repeat(40),
    basePackSha256: createHash("sha256").update("").digest("hex"),
    basePack: Buffer.alloc(0),
  });
  return owner;
}
