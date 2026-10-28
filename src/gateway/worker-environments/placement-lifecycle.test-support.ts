import { expect } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_EXEC_APPROVAL_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-exec-approval.js";
import { WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { REQUEST, type PlacementStore } from "./placement-dispatch-test-fixtures.js";
import { placementTurnOwner, type WorkerSessionPlacementRecord } from "./placement-record.js";
import { journalOwner } from "./placement-suite.test-support.js";
import { workspaceJournal } from "./workspace-manifest-fixtures.test-support.js";

type ActivePlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;
export const WORKER_PROTOCOL_FEATURES = [
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
  WORKER_EXEC_APPROVAL_PROTOCOL_FEATURE,
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
  const owner = journalOwner(active);
  await store.beginWorkspaceReconciliation(
    owner,
    workspaceJournal(active.workspaceBaseManifestRef, currentManifestRef, {
      temporaryNonce: nonce.repeat(32),
    }),
  );
  return owner;
}
