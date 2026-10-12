/** Observe layout changes, never scrolling or animation frames. */
export class BackgroundFadeLayout {
  private observer: ResizeObserver | null = null;
  private targets: Element[] = [];
  constructor(private readonly host: HTMLElement) {}

  update(enabled: boolean) {
    if (!enabled) {
      this.disconnect();
      return;
    }
    const parent = this.host.parentElement;
    const composer = parent?.querySelector<HTMLElement>(".agent-chat__input");
    const welcome = parent?.querySelector<HTMLElement>(".agent-chat__welcome");
    const targets = [parent, composer, welcome].filter((node): node is HTMLElement =>
      Boolean(node),
    );
    if (
      targets.length !== this.targets.length ||
      targets.some((node, index) => node !== this.targets[index])
    ) {
      this.disconnect();
      this.targets = targets;
      if (typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(() => this.measure());
        targets.forEach((node) => this.observer?.observe(node));
      }
    }
    this.measure();
  }

  private measure() {
    const parent = this.host.parentElement;
    const composer = parent?.querySelector<HTMLElement>(".agent-chat__input");
    const origin = this.host.getBoundingClientRect();
    const box = composer?.getBoundingClientRect();
    const scroll = parent?.querySelector<HTMLElement>(".new-session-page__scroll")?.scrollTop ?? 0;
    const end = box
      ? Math.max(0, box.top - origin.top + scroll + box.height / 2)
      : origin.height * 0.55;
    const value = Math.round(end) + "px";
    if (this.host.style.getPropertyValue("--session-background-fade-end") !== value) {
      this.host.style.setProperty("--session-background-fade-end", value);
    }
  }

  disconnect() {
    this.observer?.disconnect();
    this.observer = null;
    this.targets = [];
  }
}
