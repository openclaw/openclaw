// Live elapsed-time label that ticks once per second while the work runs.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { formatDurationCompact, formatDurationHuman } from "../lib/format-duration.ts";
import { TickingLabel } from "./ticking-label.ts";

class ElapsedTime extends TickingLabel {
  @property({ type: Number }) startMs: number | null = null;
  @property({ type: Number }) endMs: number | null = null;
  @property({ type: String }) minimumUnit: "second" | "minute" = "second";
  @property({ type: Boolean }) singleUnit = false;

  protected override get ticking() {
    return this.startMs != null && this.endMs == null;
  }

  protected override currentLabel() {
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
    return this.label === undefined ? nothing : html`${this.label}`;
  }
}

if (!customElements.get("openclaw-elapsed-time")) {
  customElements.define("openclaw-elapsed-time", ElapsedTime);
}
