// Live elapsed-time label that ticks once per second while the work runs.
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { formatDurationCompact, formatDurationHuman } from "../lib/format-duration.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { PollController } from "../lit/poll-controller.ts";

class ElapsedTime extends OpenClawLightDomContentsElement {
  @property({ type: Number }) startMs: number | null = null;
  @property({ type: Number }) endMs: number | null = null;
  @property({ type: String }) minimumUnit: "second" | "minute" = "second";
  @property({ type: Boolean }) singleUnit = false;

  private duration: string | undefined;
  private readonly polling = new PollController(
    this,
    1_000,
    () => this.requestUpdate(),
    false,
    "visible",
  );

  override connectedCallback() {
    super.connectedCallback();
    this.syncTimer();
  }

  override updated() {
    this.syncTimer();
  }

  private syncTimer() {
    const ticking = this.isConnected && this.startMs != null && this.endMs == null;
    if (ticking) {
      this.polling.start();
    } else {
      this.polling.stop();
    }
  }

  override shouldUpdate(changed: PropertyValues<this>) {
    const duration = this.currentDuration();
    const durationChanged = duration !== this.duration;
    this.duration = duration;
    return !this.hasUpdated || changed.size > 0 || durationChanged;
  }

  private currentDuration() {
    const start = this.startMs;
    if (start == null) {
      return undefined;
    }
    const end = this.endMs ?? Date.now();
    const minimumMs = this.minimumUnit === "minute" ? 60_000 : 1_000;
    const elapsedMs = Math.max(minimumMs, end - start);
    return this.singleUnit
      ? formatDurationHuman(elapsedMs)
      : formatDurationCompact(
          this.minimumUnit === "minute" ? Math.floor(elapsedMs / 60_000) * 60_000 : elapsedMs,
        );
  }

  override render() {
    return this.duration === undefined ? nothing : html`${this.duration}`;
  }
}

if (!customElements.get("openclaw-elapsed-time")) {
  customElements.define("openclaw-elapsed-time", ElapsedTime);
}
