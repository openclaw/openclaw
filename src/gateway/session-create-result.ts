import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import { readSessionCreationOperationInWorker } from "../config/sessions/session-creation-operation-read.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type {
  CreateGatewaySessionParams,
  GatewaySessionCommitResult,
} from "./session-create-service.types.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

/** New and replayed creations expose the same committed session projection. */
export function projectSessionCreationResult(
  params: Pick<CreateGatewaySessionParams, "cfg" | "creationOperation">,
  target: Pick<GatewaySessionStoreTarget, "agentId" | "canonicalKey">,
  entry: InternalSessionEntry,
  creationReplayed = false,
): Extract<GatewaySessionCommitResult, { ok: true }> {
  const selectedModel = resolveSessionModelRef(params.cfg, entry, target.agentId);
  return {
    ok: true,
    key: target.canonicalKey,
    agentId: target.agentId,
    entry: projectPublicSessionEntry(entry),
    resolved: { modelProvider: selectedModel.provider, model: selectedModel.model },
    resetExisting: false,
    ...(params.creationOperation ? { creationReplayed } : {}),
  };
}

/** Normalize creation identity and delivery before callbacks and final persistence. */
export function initializeSessionCreationIdentity(
  entry: InternalSessionEntry,
  operation: CreateGatewaySessionParams["creationOperation"],
  existingEntry: InternalSessionEntry | undefined,
): InternalSessionEntry {
  return {
    ...entry,
    // Reset retains the physical UUID but advances lifecycleRevision, retiring replay.
    ...(operation
      ? { sessionId: operation.sessionId, lifecycleRevision: operation.sessionId }
      : {}),
    // Callbacks must see the delivery shape the writer persists, not apparent drift.
    ...(existingEntry === undefined && entry.delivery === undefined
      ? { delivery: normalizeSessionDeliveryState() }
      : {}),
  };
}

/** Called under target lifecycle custody, before any workspace or placement effect. */
export async function reconcileSessionCreation(
  params: Pick<CreateGatewaySessionParams, "cfg" | "creationOperation">,
  target: GatewaySessionStoreTarget,
  commitGuard: (() => void) | undefined,
): Promise<Extract<GatewaySessionCommitResult, { ok: true }> | undefined> {
  if (!params.creationOperation) {
    return undefined;
  }
  const receipt = await readSessionCreationOperationInWorker(
    { agentId: target.agentId, storePath: target.storePath, sessionKey: target.canonicalKey },
    params.creationOperation,
  );
  commitGuard?.();
  return receipt?.creationOperationMatched && receipt.existingEntry
    ? projectSessionCreationResult(params, target, receipt.existingEntry, true)
    : undefined;
}
