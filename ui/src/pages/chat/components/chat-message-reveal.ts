import type { Virtualizer } from "@tanstack/virtual-core";
import type { TranscriptOffsetState } from "./chat-transcript-offset-observer.ts";

export class ChatMessageReveal {
  private highlight: { element: HTMLElement; timer: number } | null = null;

  constructor(private readonly messageElements: ReadonlyMap<string, HTMLElement>) {}

  complete(
    root: Node | null,
    state: Pick<TranscriptOffsetState, "scrollCommand">,
    virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    messageRowKeysById: ReadonlyMap<string, string>,
    rowIndexesByKey: ReadonlyMap<string, number>,
  ): void {
    const command = state.scrollCommand;
    if (command?.target !== "message") {
      return;
    }
    if (this.reveal(root, command, virtualizer)) {
      state.scrollCommand = { behavior: command.behavior, target: "index" };
      return;
    }
    // Expanding folded work can move the target beyond the initially mounted rows.
    const rowKey = messageRowKeysById.get(command.messageId);
    const rowIndex = rowKey ? rowIndexesByKey.get(rowKey) : undefined;
    if (rowIndex !== undefined) {
      // Native scroll and row mounts continue the reveal. Requesting another
      // render here can starve the offset notification that changes the range.
      virtualizer.scrollToIndex(rowIndex, { align: "center" });
    }
  }

  private reveal(
    root: Node | null,
    { messageId, behavior }: { messageId: string; behavior: ScrollBehavior },
    virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  ): boolean {
    const bubble = [...this.messageElements.values()].find(
      (candidate) =>
        root?.contains(candidate) &&
        (candidate.dataset.entryId ?? candidate.dataset.messageId) === messageId,
    );
    const element = virtualizer.scrollElement;
    if (!bubble || !element) {
      return false;
    }
    this.clear();
    // The layout read in scrolling also resets a repeated target's CSS animation.
    const rect = bubble.getBoundingClientRect();
    const offset =
      element.scrollTop +
      rect.top -
      element.getBoundingClientRect().top -
      element.clientTop +
      (rect.height - element.clientHeight) / 2;
    // Replace the row target so virtualizer reconciliation cannot undo the bubble reveal.
    virtualizer.scrollToOffset(offset, { behavior });
    const duration = behavior === "auto" ? 1_000 : 1_200;
    bubble.style.setProperty("--duration", `${duration}ms`);
    bubble.classList.add("chat-bubble--reply-target");
    this.highlight = {
      element: bubble,
      timer: window.setTimeout(() => this.clear(), duration),
    };
    return true;
  }

  clear(): void {
    if (!this.highlight) {
      return;
    }
    window.clearTimeout(this.highlight.timer);
    this.highlight.element.classList.remove("chat-bubble--reply-target");
    this.highlight.element.style.removeProperty("--duration");
    this.highlight = null;
  }
}
