import { createSignal } from "@solidjs/signals";
import type { ShellRouteState } from "./app-host-route-state.ts";
import { readNativeHistoryState, type NativeHistoryState } from "./native-web-chrome.ts";

/** Synchronous shell state publishes revisions; Solid commits settle its DOM waiters. */
export class ShellPresentation {
  private readonly readRevision: () => number;
  private readonly writeRevision: (next: (revision: number) => number) => number;
  readonly shellRevision = () => this.readRevision();

  constructor() {
    const [read, write] = createSignal(0, { ownedWrite: true });
    this.readRevision = read;
    this.writeRevision = write;
  }
  private disposed = false;
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
    this.invalidate();
  }
  private currentNavResizing = false;
  get navResizing(): boolean {
    return this.currentNavResizing;
  }
  set navResizing(value: boolean) {
    if (Object.is(this.currentNavResizing, value)) {
      return;
    }
    this.currentNavResizing = value;
    this.invalidate();
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
  private currentNativeHistoryState: NativeHistoryState = readNativeHistoryState();
  get nativeHistoryState(): NativeHistoryState {
    return this.currentNativeHistoryState;
  }
  set nativeHistoryState(value: NativeHistoryState) {
    if (Object.is(this.currentNativeHistoryState, value)) {
      return;
    }
    this.currentNativeHistoryState = value;
    this.invalidate();
  }

  get updateComplete(): Promise<boolean> {
    return this.commitPromise;
  }

  invalidate(): void {
    if (this.disposed) {
      return;
    }
    if (!this.resolveCommit) {
      this.commitPromise = new Promise((resolve) => {
        this.resolveCommit = resolve;
      });
    }
    this.writeRevision((revision) => revision + 1);
  }

  protected resumePresentation(): void {
    this.disposed = false;
  }

  protected suspendPresentation(): void {
    this.disposed = true;
    this.resolveCommit?.(false);
    this.resolveCommit = undefined;
    this.commitPromise = Promise.resolve(false);
  }

  protected commitPresentation(): void {
    const resolve = this.resolveCommit;
    this.resolveCommit = undefined;
    this.commitPromise = Promise.resolve(true);
    resolve?.(true);
  }
}
