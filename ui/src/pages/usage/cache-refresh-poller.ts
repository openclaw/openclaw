import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  getUsageCacheDisplayState,
  isUsageCacheIncomplete,
  type UsageCacheDisplayState,
  type UsageCacheState,
} from "./cache-status.ts";

type UsageCacheRefreshControllerOptions = {
  canRefresh: () => boolean;
  getCacheState: () => UsageCacheState;
  onRefresh: () => void;
};

const REFRESH_INTERVAL_MS = 2_000;
const MAX_REFRESH_ATTEMPTS = 60;

export class UsageCacheRefreshController implements ReactiveController {
  private timer: number | null = null;
  private attempts = 0;
  private paused = false;
  private connected = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: UsageCacheRefreshControllerOptions,
  ) {
    host.addController(this);
  }

  get displayState(): UsageCacheDisplayState {
    return getUsageCacheDisplayState(this.options.getCacheState(), this.paused);
  }

  hostConnected() {
    this.connected = true;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.sync();
  }

  hostDisconnected() {
    this.connected = false;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.reset();
  }

  reset() {
    this.suspend();
    this.attempts = 0;
    this.setPaused(false);
  }

  suspend() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  sync() {
    if (!this.connected) {
      this.suspend();
      return;
    }
    if (!isUsageCacheIncomplete(this.options.getCacheState())) {
      this.reset();
      return;
    }
    if (
      document.visibilityState !== "visible" ||
      !this.options.canRefresh() ||
      this.timer !== null
    ) {
      return;
    }
    if (this.attempts >= MAX_REFRESH_ATTEMPTS) {
      this.setPaused(true);
      return;
    }

    this.setPaused(false);
    // Start the next delay only after the previous snapshot settles. This
    // serializes refreshes and bounds a cache that never reaches fresh.
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (!this.connected || !this.options.canRefresh()) {
        return;
      }
      this.attempts += 1;
      this.options.onRefresh();
    }, REFRESH_INTERVAL_MS);
  }

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      this.suspend();
      return;
    }
    this.sync();
  };

  private setPaused(paused: boolean) {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    this.host.requestUpdate();
  }
}
