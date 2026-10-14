import type { SolidController, SolidControllerHost } from "./solid-controller-host.ts";

export class PollController implements SolidController {
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private running = false;
  private readonly handleVisibilityChange = () => {
    if (!this.isVisible()) {
      this.clearTimer();
    } else if (this.startTimer()) {
      this.tick();
    }
  };

  constructor(
    host: SolidControllerHost,
    private readonly intervalMs: number,
    private readonly tick: () => void,
    private readonly autoStart = true,
    private readonly visibility: "always" | "visible" = "always",
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    if (this.autoStart) {
      this.start();
    }
  }

  hostDisconnected(): void {
    this.stop();
  }

  start(): boolean {
    if (this.running) {
      return false;
    }
    this.running = true;
    if (this.visibility === "visible") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.startTimer();
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.visibility === "visible") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.clearTimer();
  }

  private isVisible(): boolean {
    return this.visibility === "always" || document.visibilityState !== "hidden";
  }

  private startTimer(): boolean {
    if (this.timer !== null || !this.isVisible()) {
      return false;
    }
    // Visibility events own suspension; a tick already queued at hide may finish.
    this.timer = globalThis.setInterval(() => this.tick(), this.intervalMs);
    return true;
  }

  private clearTimer(): void {
    if (this.timer === null) {
      return;
    }
    globalThis.clearInterval(this.timer);
    this.timer = null;
  }
}
