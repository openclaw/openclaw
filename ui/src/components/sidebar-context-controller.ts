import type { ReactiveController } from "lit";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { equalSidebarContext, selectSidebarContext } from "./sidebar-context-state.ts";

/** Preserve the shared sidebar's scroll position for each destination. */
export class SidebarContextController implements ReactiveController {
  private readonly positions = new Map<string, number>();
  private presentedKey = "sessions";

  constructor(private readonly host: AppSidebarSessionNavigationElement) {
    new SubscriptionsController(host).watch(
      () => host.router,
      (router, notify) => {
        const stop = router.subscribeSelector(selectSidebarContext, notify, equalSidebarContext);
        return () => {
          stop();
          host.contextualSidebar = undefined;
        };
      },
      (router) => {
        host.contextualSidebar = selectSidebarContext(router.getState());
      },
    );
    host.addController(this);
  }

  hostUpdate(): void {
    if (!this.host.isConnected || this.key === this.presentedKey) {
      return;
    }
    const scroller = this.scroller;
    if (scroller) {
      this.positions.set(this.presentedKey, scroller.scrollTop);
    }
  }

  hostUpdated(): void {
    if (!this.host.isConnected || this.key === this.presentedKey) {
      return;
    }
    this.presentedKey = this.key;
    const scroller = this.scroller;
    if (scroller) {
      scroller.scrollTop = this.positions.get(this.key) ?? 0;
      this.host.sessionData.updateSessionsScrollState(scroller);
    }
  }

  handleScroll(event: Event): void {
    const scroller = event.currentTarget;
    if (!(scroller instanceof HTMLElement)) {
      return;
    }
    this.positions.set(this.presentedKey, scroller.scrollTop);
    this.host.sessionData.updateSessionsScrollState(scroller);
  }

  private get key(): string {
    return this.host.contextualSidebar?.key ?? "sessions";
  }
  private get scroller(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(".sidebar-shell__body");
  }
}
