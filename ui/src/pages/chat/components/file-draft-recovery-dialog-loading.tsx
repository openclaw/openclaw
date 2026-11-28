import { lazy } from "solid-js";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import type { FileDraft } from "./file-draft-recovery-dialog-view.tsx";

const FileDraftRecoveryDialog = lazy(() => import("./file-draft-recovery-dialog-view.tsx"), {
  export: "FileDraftRecoveryDialog",
});

export function reviewFileDrafts(drafts: readonly FileDraft[]): Promise<void> {
  return withPromiseModalHost<void>(undefined, async (modal) => {
    await FileDraftRecoveryDialog.preload();
    const currentDrafts = drafts.filter((draft) => draft.isCurrent());
    if (currentDrafts.length === 0) {
      modal.finish();
      return;
    }
    modal.render(() => (
      <FileDraftRecoveryDialog
        drafts={currentDrafts}
        settled={() => modal.settled}
        finish={modal.finish}
      />
    ));
  });
}
