import type { ReactiveController, ReactiveControllerHost } from "lit";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";

type ConfigRouteScrollHost = ReactiveControllerHost & {
  readonly isConnected: boolean;
  readonly renderRoot: ParentNode;
};

export class ConfigRouteScrollController implements ReactiveController {
  private targetId: string | null = null;
  private frame: number | null = null;

  constructor(private readonly host: ConfigRouteScrollHost) {
    host.addController(this);
  }

  setTarget(targetId: string | null): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.targetId = targetId;
  }

  hostDisconnected(): void {
    this.setTarget(null);
  }

  hostUpdated(): void {
    if (!this.targetId || this.frame !== null) {
      return;
    }
    // Starting smooth scroll during the navigation render can leave Chromium
    // at the old offset. Resolve the latest target after that render settles.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const targetId = this.targetId;
      if (!this.host.isConnected || !targetId) {
        return;
      }
      const target = [...this.host.renderRoot.querySelectorAll<HTMLElement>("[id]")].find(
        (element) => element.id === targetId,
      );
      if (!target) {
        return;
      }
      target.scrollIntoView?.({ behavior: resolveScrollBehavior(), block: "start" });
      this.targetId = null;
    });
  }
}
