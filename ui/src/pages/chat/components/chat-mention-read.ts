import { createMemo, createSignal, useContext } from "solid-js";
import { projectMentions, projectSidebarMentions } from "../../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { createIntersectionObserver } from "../../../lib/reactive/observers.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { TranscriptReadPresentation } from "./chat-transcript-layout.ts";

/** The mounted source bubble, not session activation or prewarming, acknowledges a mention. */
export function createChatMentionReadRef(
  options: () => Pick<GroupedMessageOptions, "entryId" | "sessionKey" | "agentId">,
) {
  const app = useOptionalApplication();
  if (!app) {
    return undefined;
  }
  const presented = useContext(TranscriptReadPresentation);
  const documentVisible = createDocumentVisibility();
  const [element, setElement] = createSignal<HTMLElement>();
  const source = projectSidebarMentions(app.sidebarAttention);
  const inbox = createMemo(() => {
    const owner = source.read();
    return owner ? { owner, view: projectMentions(owner) } : null;
  });
  const pending = createMemo(() => {
    const current = inbox();
    const snapshot = current?.view.read();
    const { entryId, sessionKey, agentId } = options();
    return snapshot?.phase === "ready" && entryId && sessionKey
      ? snapshot.items.filter(
          (item) =>
            item.messageId === entryId &&
            item.agentId === agentId &&
            areUiSessionKeysEquivalent(item.sessionKey, sessionKey) &&
            !snapshot.dismissing.includes(item.id),
        )
      : [];
  });
  createIntersectionObserver(
    () => {
      const target = element();
      return target && presented() && documentVisible() && pending().length ? [target] : [];
    },
    (entries) => {
      // Recheck live owners: an observer delivery can outlive navigation or a tab hiding.
      if (!presented() || document.visibilityState === "hidden") {
        return;
      }
      if (
        entries.some(
          (entry) =>
            entry.target === element() &&
            entry.target.isConnected &&
            entry.isIntersecting &&
            entry.intersectionRect.width > 0 &&
            entry.intersectionRect.height > 0,
        )
      ) {
        void inbox()?.owner.dismiss(pending().map((item) => item.id));
      }
    },
  );
  return elementRef((target: HTMLElement) => {
    setElement(target);
  });
}
