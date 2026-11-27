import { lazy } from "solid-js";
import { activeElement } from "../../../components/focus-navigation.ts";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import type { VoiceSnippetReview } from "../voice-snippet-review.ts";
import { VoiceSnippetDialogBoundary } from "./voice-snippet-dialog-boundary.tsx";

const ReviewDialog = lazy(() => import("./voice-snippet-review-dialog.tsx"), {
  export: "VoiceSnippetReviewDialog",
});

export async function showVoiceSnippetReview(options: {
  owner: VoiceSnippetReview;
  signal: AbortSignal;
  getAcceptedFocusTarget: () => HTMLElement | undefined;
}): Promise<boolean> {
  let accepted = false;
  const returnFocus = activeElement(document.body);
  try {
    accepted = await withPromiseModalHost<boolean>(
      { signal: options.signal, value: false },
      (modal) => {
        const context = {
          owner: options.owner,
          signal: options.signal,
          returnFocus,
          getAcceptedFocusTarget: options.getAcceptedFocusTarget,
          finish: modal.finish,
        };
        const cancel = () => {
          options.owner.cancel();
          modal.finish(false);
        };
        modal.render(() => (
          <VoiceSnippetDialogBoundary signal={options.signal} onClose={cancel}>
            <ReviewDialog context={context} />
          </VoiceSnippetDialogBoundary>
        ));
      },
    );
    return accepted;
  } finally {
    if (!accepted) {
      options.owner.cancel();
    }
  }
}
