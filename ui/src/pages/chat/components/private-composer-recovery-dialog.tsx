import { lazy } from "solid-js";
import { ensureCustomElementDefined } from "../../../app/lazy-custom-element.ts";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";

export type PrivateComposerDraft = {
  text: string;
  attachments: readonly ChatAttachment[];
  hasGoal: boolean;
  pendingReads: number;
  isCurrent: () => boolean;
  signal: AbortSignal;
  labels?: { title: string; description: string; text: string; discard: string };
};

const PrivateComposerRecoveryDialog = lazy(
  () => import("./private-composer-recovery-content.tsx"),
  {
    export: "PrivateComposerRecoveryDialog",
  },
);

/** Pending memory-only input needs this escape surface before a build replaces its assets. */
export async function preloadPrivateComposerRecovery(): Promise<void> {
  await Promise.all([
    PrivateComposerRecoveryDialog.preload(),
    ensureCustomElementDefined(
      "openclaw-modal-dialog",
      () => import("../../../components/modal-dialog.tsx"),
    ),
  ]);
}

export function reviewPrivateComposerDraft(params: PrivateComposerDraft): Promise<boolean> {
  return withPromiseModalHost(
    { signal: params.signal, value: false },
    async ({ render, finish }) => {
      await preloadPrivateComposerRecovery();
      if (params.signal.aborted || !params.isCurrent()) {
        finish(false);
        return;
      }
      render(() => <PrivateComposerRecoveryDialog {...params} finish={finish} />);
    },
  );
}
