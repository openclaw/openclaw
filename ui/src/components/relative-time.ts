import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/format.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { PollController } from "../lit/poll-controller.ts";

class RelativeTime extends OpenClawLightDomElement {
  @property({ attribute: false }) timestampMs: number | null = null;

  private readonly polling = new PollController(
    this,
    60_000,
    () => this.requestUpdate(),
    false,
    "visible",
  );

  override connectedCallback() {
    super.connectedCallback();
    this.polling.start();
    this.requestUpdate();
  }

  override render() {
    const timestamp = asDateTimestampMs(this.timestampMs);
    return timestamp === undefined
      ? nothing
      : html`<time
          datetime=${new Date(timestamp).toISOString()}
          title=${formatDateTimeMs(timestamp)}
          >${formatRelativeTimestamp(timestamp)}</time
        >`;
  }
}

if (!customElements.get("openclaw-relative-time")) {
  customElements.define("openclaw-relative-time", RelativeTime);
}
