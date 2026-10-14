import { createComponent } from "solid-js";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { FileDraftRecoveryDialog, type FileDraft } from "./file-draft-recovery-dialog-view.tsx";

export type { FileDraft } from "./file-draft-recovery-dialog-view.tsx";

export function reviewFileDrafts(drafts: readonly FileDraft[]): Promise<void> {
  return withPromiseModalHost<void>(undefined, (modal) => {
    modal.render(() =>
      createComponent(FileDraftRecoveryDialog, {
        drafts,
        settled: () => modal.settled,
        finish: modal.finish,
      }),
    );
  });
}
