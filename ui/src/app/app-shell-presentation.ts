import { createSignal } from "@solidjs/signals";
import type { GatewayStatusProps } from "../components/gateway-status.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ShellView } from "./app-shell-view-state.ts";
import { readNativeHistoryState } from "./native-web-chrome.ts";

/** Synchronous shell state publishes revisions; Solid commits settle its DOM waiters. */
export abstract class ShellPresentation {
  mobileGatewayStatus: GatewayStatusProps | null = null;
  connectionRecovery = false;
  protected connectionFlagVisible = false;
  private connectionKind: GatewayStatusProps["kind"] | undefined;
  private connectionRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionFlagTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly revision = createSignal(0, { ownedWrite: true });
  readonly shellRevision = this.revision[0];
  private readonly navigation = createSignal(0, { ownedWrite: true });
  readonly navigationRevision = this.navigation[0];
  private shellCommitPending = false;
  private disposed = false;
  private presentationMounted = false;
  private commitPromise: Promise<boolean> = Promise.resolve(true);
  private resolveCommit: ((committed: boolean) => void) | undefined;
  private currentNavDrawerOpen = false;
  get navDrawerOpen(): boolean {
    return this.currentNavDrawerOpen;
  }
  set navDrawerOpen(value: boolean) {
    if (Object.is(this.currentNavDrawerOpen, value)) {
      return;
    }
    this.currentNavDrawerOpen = value;
    if (!this.disposed) {
      this.requestCommit();
      this.navigation[1]((revision) => revision + 1);
    }
  }
  private currentDesktopNavigationExpanded = false;
  get desktopNavigationExpanded(): boolean {
    return this.currentDesktopNavigationExpanded;
  }
  set desktopNavigationExpanded(value: boolean) {
    if (Object.is(this.currentDesktopNavigationExpanded, value)) {
      return;
    }
    this.currentDesktopNavigationExpanded = value;
    this.invalidate();
  }
  private currentActiveSessionKey = "";
  get activeSessionKey(): string {
    return this.currentActiveSessionKey;
  }
  set activeSessionKey(value: string) {
    if (Object.is(this.currentActiveSessionKey, value)) {
      return;
    }
    this.currentActiveSessionKey = value;
    this.invalidate();
  }
  private currentSettingsSearchQuery = "";
  get settingsSearchQuery(): string {
    return this.currentSettingsSearchQuery;
  }
  set settingsSearchQuery(value: string) {
    if (Object.is(this.currentSettingsSearchQuery, value)) {
      return;
    }
    this.currentSettingsSearchQuery = value;
    this.invalidate();
  }
  private currentRouteState: ShellRouteState = {};
  get routeState(): ShellRouteState {
    return this.currentRouteState;
  }
  set routeState(value: ShellRouteState) {
    if (Object.is(this.currentRouteState, value)) {
      return;
    }
    this.currentRouteState = value;
    this.invalidate();
  }
  private readonly nativeHistory = createSignal(readNativeHistoryState(), { ownedWrite: true });
  readonly nativeHistoryState = this.nativeHistory[0];
  readonly setNativeHistoryState = this.nativeHistory[1];

  protected syncConnectionFeedback(kind: GatewayStatusProps["kind"]): void {
    // Only a kind transition replaces the brief recovery row and avatar flag timers.
    if (kind !== this.connectionKind) {
      const previous = this.connectionKind;
      const wasRecovery = this.connectionRecovery;
      const wasFlagVisible = this.connectionFlagVisible;
      this.clearConnectionFeedbackTimers();
      this.connectionKind = kind;
      this.connectionRecovery =
        kind === "connected" && previous != null && previous !== "connected";
      this.connectionFlagVisible = Boolean(
        kind && (kind !== "connected" || this.connectionRecovery),
      );
      if (this.connectionRecovery) {
        this.connectionRecoveryTimer = setTimeout(() => {
          this.connectionRecoveryTimer = undefined;
          this.connectionRecovery = false;
          this.invalidate();
        }, 2_000);
      }
      if (this.connectionFlagVisible) {
        this.connectionFlagTimer = setTimeout(() => {
          this.connectionFlagTimer = undefined;
          this.connectionFlagVisible = false;
          this.invalidate();
        }, 4_000);
      }
      if (
        wasRecovery !== this.connectionRecovery ||
        wasFlagVisible !== this.connectionFlagVisible
      ) {
        this.invalidate();
      }
    }
  }

  protected resetConnectionFeedback(): void {
    this.clearConnectionFeedbackTimers();
    this.connectionKind = undefined;
    this.connectionRecovery = false;
    this.connectionFlagVisible = false;
    this.mobileGatewayStatus = null;
  }

  private clearConnectionFeedbackTimers(): void {
    clearTimeout(this.connectionRecoveryTimer);
    clearTimeout(this.connectionFlagTimer);
    this.connectionRecoveryTimer = undefined;
    this.connectionFlagTimer = undefined;
  }

  get updateComplete(): Promise<boolean> {
    return this.commitPromise;
  }

  mountPresentation(): () => void {
    this.presentationMounted = true;
    this.invalidate();
    return () => {
      this.presentationMounted = false;
      this.suspendPresentation();
    };
  }

  protected abstract afterCommit(): void;
  protected abstract afterNavigationCommit(view: ShellView): void;

  commitRenderedPresentation(view: ShellView): void {
    if (this.disposed || !this.presentationMounted || !this.resolveCommit) {
      return;
    }
    if (this.shellCommitPending) {
      this.afterCommit();
    } else {
      this.afterNavigationCommit(view);
    }
  }

  invalidate(): void {
    if (this.disposed) {
      return;
    }
    this.shellCommitPending = true;
    this.requestCommit();
    this.revision[1]((revision) => revision + 1);
  }

  private requestCommit(): void {
    if (!this.resolveCommit) {
      this.commitPromise = new Promise((resolve) => {
        this.resolveCommit = resolve;
      });
    }
  }

  protected resumePresentation(): void {
    this.disposed = false;
    this.invalidate();
  }

  protected suspendPresentation(): void {
    this.disposed = true;
    this.resolveCommit?.(false);
    this.resolveCommit = undefined;
    this.commitPromise = Promise.resolve(false);
  }

  protected commitPresentation(): void {
    this.shellCommitPending = false;
    const resolve = this.resolveCommit;
    this.resolveCommit = undefined;
    this.commitPromise = Promise.resolve(true);
    resolve?.(true);
  }
}
