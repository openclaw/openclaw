import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { localWorkspaceProjectionPath } from "./local-workspace-checkout.js";
import { assertLocalWorkspaceProjectionOwner } from "./local-workspace-owner-identity.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

/** Only a committed cut receipt plus live successor authority can change incarnation. */
export async function finishLocalWorkspaceHandoff(
  owner: LocalWorkspaceOwner,
  handoff: NonNullable<InternalSessionEntry["localWorkspaceHandoff"]>,
) {
  owner.assertCurrent();
  if (
    handoff.worktreeId !== owner.worktree.id ||
    handoff.toSessionId !== owner.sessionId ||
    handoff.lifecycleRevision !== owner.lifecycleRevision
  ) {
    throw new Error("Local workspace handoff belongs to a different session incarnation");
  }
  await withLocalWorkspaceStore({ ...owner, worktreeId: owner.worktree.id }, async (store) => {
    const row = store.get();
    if (!row) {
      throw new Error(
        "Local workspace handoff lost its saved projection; recovery data was preserved",
      );
    }
    if (row.session_id === owner.sessionId) {
      assertLocalWorkspaceProjectionOwner(row, owner, localWorkspaceProjectionPath(owner));
      return;
    }
    assertLocalWorkspaceProjectionOwner(
      row,
      { ...owner, sessionId: handoff.fromSessionId },
      localWorkspaceProjectionPath(owner),
    );
    if (
      row.revision !== handoff.projectionRevision ||
      row.pending_ref ||
      row.journal_json ||
      row.paused_runtimes_json
    ) {
      throw new Error(
        "Local workspace changed after history-cut settlement; saved edits were preserved",
      );
    }
    // Update only ownership. Baselines, inventories, files and recovery receipts stay put.
    // The store recovers committed facts after reply loss before releasing custody.
    await store.update(row, { session_id: owner.sessionId }, owner.workerAuthority);
  });
}
