import { assert } from "vitest";
import { preparePendingInputStore, type PendingInputScope } from "./session-pending-input-store.js";

/** Inspect retained rows that ordinary pending-input history intentionally hides. */
export async function readPendingInputSnapshotForTest(
  scope: PendingInputScope,
  idempotencyKey: string,
) {
  const store = await preparePendingInputStore(scope, () => {});
  try {
    const snapshot = await store.read({
      kind: "source",
      sessionKey: store.sessionKey,
      sessionId: scope.sessionId,
      idempotencyKey,
      pendingOnly: true,
    });
    assert(snapshot.kind === "source", "Expected pending-input source snapshot");
    return snapshot;
  } finally {
    await store.release();
  }
}
