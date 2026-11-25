import { ensureCustomElementDefined } from "../app/lazy-custom-element.ts";
import { composedParent } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";

export type HovercardBootstrapTrigger = "focus" | "pointer";

export class LazyHovercardBootstrap<TElement extends HTMLElement> {
  private stopListeners: (() => void) | null = null;

  constructor(
    private readonly params: {
      tag: string;
      load: () => Promise<CustomElementConstructor>;
    },
  ) {}

  install(activate: (event: Event, trigger: HovercardBootstrapTrigger) => Promise<void>): void {
    if (!customElements.get(this.params.tag)) {
      const stop = [
        listen(document, "pointerover", (event) => void activate(event, "pointer"), true),
        listen(document, "focusin", (event) => void activate(event, "focus"), true),
      ];
      this.stopListeners = () => stop.forEach((remove) => remove());
    }
  }

  providerFor(target: Element): TElement | null {
    let element: Element | null = target;
    while (element) {
      const owner = element.closest<TElement>(this.params.tag);
      if (owner) {
        return owner;
      }
      element = composedParent(element);
    }
    return null;
  }

  async define(): Promise<void> {
    await ensureCustomElementDefined(this.params.tag, async () => {
      const provider = await this.params.load();
      // Another loader may register the tag while this import is pending.
      if (!customElements.get(this.params.tag)) {
        customElements.define(this.params.tag, provider);
      }
    });
    this.stopListeners?.();
    this.stopListeners = null;
  }
}

export function hovercardBootstrapIntentActive(
  target: HTMLElement,
  trigger: HovercardBootstrapTrigger,
  focusWithin = false,
): boolean {
  if (trigger === "pointer") {
    return target.matches(":hover");
  }
  return focusWithin
    ? document.activeElement instanceof Node && target.contains(document.activeElement)
    : target.matches(":focus");
}

export function remainingHovercardOpenDelay(startedAt: number, openDelayMs: number): number {
  return Math.max(0, openDelayMs - (performance.now() - startedAt));
}
