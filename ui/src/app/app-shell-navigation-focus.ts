import type { LitElement } from "lit";
import { isAbortError, racePromiseWithAbortSignal } from "../../../src/infra/abort-signal.js";
import type { ChatPage } from "../pages/chat/chat-page.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext } from "./context.ts";
import { isMobileNavLayout } from "./mobile-nav-layout.ts";

interface ShellNavigationFocusHost extends HTMLElement {
  readonly context: ApplicationContext | undefined;
  readonly routeState: ShellRouteState;
  readonly updateComplete: Promise<boolean>;
  readonly onboardingMode: boolean;
  readonly navDrawerOpen: boolean;
}

/** Owns one responsive focus handoff until its destination commits or newer intent cancels it. */
export class ShellNavigationFocusOwner {
  private pending: AbortController | undefined;

  constructor(
    private readonly host: ShellNavigationFocusHost,
    private readonly restoreFocusTo: (target: HTMLElement | null | undefined) => void,
  ) {}

  cancel(): void {
    this.pending?.abort();
    this.pending = undefined;
  }

  async restore(): Promise<void> {
    this.cancel();
    const pending = new AbortController();
    this.pending = pending;
    const host = this.host;
    const context = host.context;
    const route = host.routeState;
    const href = window.location.href;
    const navigation = host.querySelector(".shell-nav");
    const wait = (completion: Promise<unknown> | undefined) =>
      racePromiseWithAbortSignal(Promise.resolve(completion), pending.signal);
    const current = () =>
      this.pending === pending &&
      !pending.signal.aborted &&
      host.isConnected &&
      host.context === context &&
      host.routeState === route &&
      window.location.href === href &&
      isMobileNavLayout() &&
      !host.onboardingMode &&
      !host.navDrawerOpen;
    // Menu teardown may restore its old sidebar trigger. Only newer outside focus supersedes it.
    host.ownerDocument.addEventListener(
      "focusin",
      (event) => {
        if (event.target instanceof Node && !navigation?.contains(event.target)) {
          pending.abort();
        }
      },
      { capture: true, signal: pending.signal },
    );
    try {
      await wait(host.updateComplete);
      // Native media-query changes follow resize delivery. Keep the existing frame boundary,
      // then join actual render owners instead of assuming that frame committed their DOM.
      await wait(
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
      );
      if (!current()) {
        return;
      }
      const pageSelector = ".shell--merged-chat-chrome openclaw-chat-page";
      const page = host.querySelector<ChatPage>(pageSelector);
      await wait(page?.updateComplete);
      if (!current() || (page && (!page.isConnected || !page.presented))) {
        return;
      }
      const paneSelector =
        "openclaw-chat-pane.chat-pane-cache__pane--active.chat-pane-cache__pane--visible";
      const pane = page?.querySelector<HTMLElementTagNameMap["openclaw-chat-pane"]>(paneSelector);
      if (page && !pane) {
        return;
      }
      const owner = pane ?? host.querySelector<LitElement>("openclaw-app-topbar");
      await wait(owner?.updateComplete);
      const recipientCurrent = () =>
        page
          ? host.querySelector(pageSelector) === page &&
            page.isConnected &&
            page.presented &&
            page.querySelector(paneSelector) === pane &&
            pane?.presented
          : host.querySelector("openclaw-app-topbar") === owner;
      if (!current() || !recipientCurrent()) {
        return;
      }
      const toggleSelector = pane ? ".chat-pane__nav-toggle" : ".topbar-nav-toggle";
      const target = owner?.querySelector<HTMLElement>(toggleSelector);
      const tooltip =
        target?.closest<HTMLElementTagNameMap["openclaw-tooltip"]>("openclaw-tooltip");
      // The light-DOM button is not visible until its enclosing tooltip's shadow slot commits.
      await wait(tooltip?.updateComplete);
      if (
        current() &&
        recipientCurrent() &&
        owner?.querySelector(toggleSelector) === target &&
        target?.closest("openclaw-tooltip") === tooltip
      ) {
        this.restoreFocusTo(target);
      }
    } catch (error) {
      if (!pending.signal.aborted || !isAbortError(error)) {
        throw error;
      }
    } finally {
      pending.abort();
      if (this.pending === pending) {
        this.pending = undefined;
      }
    }
  }
}
