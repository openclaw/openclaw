import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { showToast } from "../../lib/toast.ts";
import { releaseChatAttachmentPayload } from "./attachment-payload-store.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";

type BrowserAnnotationRemovalHost = {
  getOwner: () => object | undefined;
  getSessionKey: () => string;
  getAttachments: () => ChatAttachment[];
  setAttachments: (attachments: ChatAttachment[]) => void;
  requestUpdate: () => void;
  focusComposer: () => void;
  focusRestoredAnnotation: (attachmentId: string) => void;
};

/** Removes one annotation package while the shared toast owns its bounded Undo lifetime. */
export function removeBrowserAnnotationWithUndo(
  host: BrowserAnnotationRemovalHost,
  attachment: ChatAttachment,
  labels: { removed: string; undo: string; undoUnavailable: string },
): boolean {
  if (!attachment.browserAnnotation) {
    return false;
  }
  const modelContext = attachment.browserAnnotation.modelContext;
  const sourceOwner = host.getOwner();
  const sourceSessionKey = host.getSessionKey();
  const current = host.getAttachments();
  const sourceIndex = current.findIndex((candidate) => candidate.id === attachment.id);
  if (sourceIndex < 0) {
    return false;
  }

  host.setAttachments(current.filter((candidate) => candidate.id !== attachment.id));
  host.requestUpdate();
  host.focusComposer();

  let settled = false;
  const finalizeRemoval = () => {
    if (settled) {
      return;
    }
    settled = true;
    releaseChatAttachmentPayload(attachment.id);
  };
  const presented = showToast({
    message: labels.removed,
    actionLabel: labels.undo,
    onAction: () => {
      if (settled) {
        return;
      }
      if (host.getOwner() !== sourceOwner || host.getSessionKey() !== sourceSessionKey) {
        finalizeRemoval();
        return;
      }
      const latest = host.getAttachments();
      if (latest.some((candidate) => candidate.id === attachment.id)) {
        settled = true;
        return;
      }
      if (!canAdmitBrowserAnnotation(latest, modelContext)) {
        finalizeRemoval();
        showToast({ message: labels.undoUnavailable });
        return;
      }
      settled = true;
      const restored = [...latest];
      restored.splice(Math.min(sourceIndex, latest.length), 0, attachment);
      host.setAttachments(restored);
      host.requestUpdate();
      host.focusRestoredAnnotation(attachment.id);
    },
    onDismiss: (reason) => {
      if (reason !== "action") {
        finalizeRemoval();
      }
    },
  });
  if (!presented) {
    finalizeRemoval();
  }
  return true;
}
