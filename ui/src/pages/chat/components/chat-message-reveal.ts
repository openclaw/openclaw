export class ChatMessageReveal {
  private highlight: { element: HTMLElement; timer: number } | null = null;

  reveal(
    root: ParentNode | null,
    { messageId, behavior }: { messageId: string; behavior: ScrollBehavior },
  ): boolean {
    const bubble = [...(root?.querySelectorAll<HTMLElement>(".chat-bubble") ?? [])].find(
      (candidate) => candidate.dataset.entryId === messageId,
    );
    if (!bubble) {
      return false;
    }
    this.clear();
    // The layout read in scrolling also resets a repeated target's CSS animation.
    bubble.scrollIntoView?.({ behavior, block: "center" });
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
