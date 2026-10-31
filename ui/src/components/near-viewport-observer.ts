import { observeIntersection } from "../lib/reactive/observers.ts";

export class NearViewportObserver {
  private stop?: () => void;
  nearVisible = false;
  target?: Element;

  constructor(
    private readonly marginPx: number,
    private readonly visibilityChanged: () => void,
  ) {}

  observe(target: Element): void {
    if (target === this.target) {
      return;
    }
    this.disconnect();
    this.target = target;
    this.setNearVisible(this.isNearViewport(target));
    this.stop = observeIntersection(
      [target],
      (entries) => {
        const entry = entries.at(-1);
        if (!entry || entry.target !== this.target) {
          return;
        }
        this.setNearVisible(entry.isIntersecting || this.isNearViewport(entry.target));
      },
      { rootMargin: `${this.marginPx}px 0px` },
    );
  }

  disconnect(): void {
    this.stop?.();
    this.stop = undefined;
    this.target = undefined;
    this.setNearVisible(false);
  }

  private setNearVisible(nearVisible: boolean): void {
    if (nearVisible !== this.nearVisible) {
      this.nearVisible = nearVisible;
      this.visibilityChanged();
    }
  }

  private isNearViewport(target: Element): boolean {
    const bounds = target.getBoundingClientRect();
    return bounds.bottom >= -this.marginPx && bounds.top <= window.innerHeight + this.marginPx;
  }
}
