import { commitComposerDraft, queueComposerSubmit } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

/**
 * Enter while the session is still loading keeps the exact draft queued; the
 * composer submits it through the same admission once loading ends. Any edit
 * withdraws it, and a hold that is not loading leaves the draft unsent.
 */
export function createQueuedSubmit(
  props: ChatComposerProps,
  state: ChatComposerState,
  visibleDraft: string,
  canSubmitDraft: (draft: string) => boolean,
  submitDraft: (draft: string) => void,
) {
  const queued = state.presentation.queuedSubmit;
  const submitQueued = queued !== null && queued === visibleDraft;
  return {
    submitQueued,
    queuedSubmitDue:
      queued !== null && (!submitQueued || !props.submitPending || canSubmitDraft(visibleDraft)),
    queueSubmit: (draft: string) => {
      commitComposerDraft(props, draft);
      queueComposerSubmit(state, draft);
    },
    flushQueuedSubmit: () => {
      const current = state.presentation.queuedSubmit;
      if (current === null) {
        return;
      }
      const draft = props.getDraft?.() ?? props.draft;
      if (current === draft && props.submitPending && !canSubmitDraft(draft)) {
        return;
      }
      queueComposerSubmit(state, null);
      if (current === draft) {
        submitDraft(draft);
      }
    },
  };
}
