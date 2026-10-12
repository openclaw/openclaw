import type { SidebarSessionsScrollState } from "./app-sidebar-session-types.ts";
import { observeScrollState } from "./scroll-state-observer.ts";

/** Owns the sidebar's projection of shared scroll observations. */
export class SessionDataScrollController {
  state: SidebarSessionsScrollState = "none";
  private element: HTMLElement | null = null;
  private observation: ReturnType<typeof observeScrollState> | undefined;

  constructor(private readonly notify: () => void) {}

  synchronize(host: Pick<HTMLElement, "querySelector">): void {
    const element = host.querySelector<HTMLElement>(".sidebar-shell__body");
    if (element !== this.element) {
      this.dispose();
      this.element = element;
      if (element) {
        this.observation = observeScrollState(element, (state) => {
          const next = !state.scrollable
            ? "none"
            : state.atStart
              ? "top"
              : state.atEnd
                ? "bottom"
                : "middle";
          if (next !== this.state) {
            this.state = next;
            this.notify();
          }
        });
      }
    }
    this.observation?.schedule();
  }

  update(_element: HTMLElement): void {
    this.observation?.schedule();
  }

  dispose(): void {
    this.observation?.disconnect();
    this.observation = undefined;
    this.element = null;
  }
}
