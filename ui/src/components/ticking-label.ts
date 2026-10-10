import type { PropertyValues } from "lit";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { PollController } from "../lit/poll-controller.ts";

/** Time-derived labels poll while visible and render only when their text changes. */
export abstract class TickingLabel extends OpenClawLightDomContentsElement {
  protected label: string | undefined;
  protected abstract get ticking(): boolean;
  protected abstract currentLabel(): string | undefined;

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
    if (this.isConnected && this.ticking) {
      this.polling.start();
    } else {
      this.polling.stop();
    }
  }

  override shouldUpdate(changed: PropertyValues<this>) {
    const label = this.currentLabel();
    const labelChanged = label !== this.label;
    this.label = label;
    return !this.hasUpdated || changed.size > 0 || labelChanged;
  }
}
