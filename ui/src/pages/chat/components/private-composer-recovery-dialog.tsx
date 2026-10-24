import { lazy } from "solid-js";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";

export type PrivateComposerDraft = {
  text: string;
  attachments: readonly ChatAttachment[];
  hasGoal: boolean;
  pendingReads: number;
  isCurrent: () => boolean;
  signal: AbortSignal;
};

const PrivateComposerRecoveryDialog = lazy(
  () => import("./private-composer-recovery-content.tsx"),
  {
    export: "PrivateComposerRecoveryDialog",
  },
);

export function reviewPrivateComposerDraft(params: PrivateComposerDraft): Promise<boolean> {
  return withPromiseModalHost(
    { signal: params.signal, value: false },
    async ({ render, finish }) => {
      await PrivateComposerRecoveryDialog.preload();
      if (params.signal.aborted || !params.isCurrent()) {
        finish(false);
        return;
      }
      render(() => <PrivateComposerRecoveryDialog {...params} finish={finish} />);
    },
  );
}
