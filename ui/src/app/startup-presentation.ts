import { createContext } from "@lit/context";

export const STARTUP_REGION_READY_EVENT = "openclaw-startup-region-ready";

export type StartupPresentation = {
  stage: "pending" | "chrome" | "ready";
  placeholderVisible: boolean;
  initialAssistantName?: string;
};

export const READY_STARTUP_PRESENTATION: StartupPresentation = {
  stage: "ready",
  placeholderVisible: false,
};
export const startupPresentationContext = createContext<StartupPresentation>(
  "openclaw-startup-presentation",
);

/** One document owns initial feedback; reconnects and background loads never rearm it. */
export class StartupPresentationController {
  snapshot: StartupPresentation = READY_STARTUP_PRESENTATION;
  started = false;
  retainSkeletons = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chromeReady = false;
  private contentReady = false;
  private shownAt: number | undefined;

  constructor(private readonly publish: (snapshot: StartupPresentation) => void) {}

  start(initialAssistantName?: string) {
    this.dispose();
    this.started = true;
    this.retainSkeletons = true;
    this.chromeReady = false;
    this.contentReady = false;
    this.shownAt = undefined;
    this.set({
      stage: "pending",
      placeholderVisible: false,
      initialAssistantName,
    });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.shownAt = performance.now();
      this.set({ ...this.snapshot, placeholderVisible: true });
      this.advance();
    }, 150);
  }

  update(chromeReady: boolean, contentReady: boolean) {
    this.chromeReady ||= chromeReady;
    this.contentReady ||= contentReady;
    this.advance();
  }

  finish() {
    this.dispose();
    this.set({ ...this.snapshot, ...READY_STARTUP_PRESENTATION });
  }

  releaseSkeletons() {
    if (this.snapshot.stage !== "ready" || !this.retainSkeletons) {
      return;
    }
    this.retainSkeletons = false;
    this.set({ ...this.snapshot });
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private set(snapshot: StartupPresentation) {
    this.snapshot = snapshot;
    this.publish(snapshot);
  }

  private advance() {
    const { stage } = this.snapshot;
    if (stage === "ready" || !this.chromeReady || (stage === "chrome" && !this.contentReady)) {
      return;
    }
    const remaining = this.shownAt === undefined ? 0 : this.shownAt + 300 - performance.now();
    if (remaining > 0) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.advance();
      }, remaining);
      return;
    }
    if (this.contentReady) {
      this.finish();
      return;
    }
    // The transcript keeps the skeleton already painted with the chrome. Its
    // minimum dwell and pulse must not restart at this presentation boundary.
    this.set({ ...this.snapshot, stage: "chrome" });
  }
}
