import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { configureAnchoredPopup } from "../../components/anchored-overlay.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatUnit } from "../../lib/format.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import type { PluginInstallProgress } from "./install-progress.ts";
import "./install-action.css";

registerPluginManagementEnglish();

export class PluginInstallAction extends OpenClawLightDomElement {
  @property({ attribute: false }) progress?: PluginInstallProgress;
  @property({ attribute: false }) busy = false;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) pluginName = "";
  @property({ attribute: false }) buttonClass = "";
  @property({ attribute: false }) primary = false;
  @property({ attribute: false }) onInstall = () => {};
  @state() private open = false;
  @state() private now = Date.now();
  private pinned = false;
  private hovering = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly progressId = `plugin-install-progress-${generateUUID()}`;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleEscape);
  }

  override disconnectedCallback() {
    clearInterval(this.timer);
    document.removeEventListener("keydown", this.handleEscape);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues) {
    if (changed.has("progress") || changed.has("busy")) {
      // Lit refs run before first-render nodes are inserted. Restored progress needs
      // its anchor configured after the button and popup have committed.
      this.configurePopup();
      clearInterval(this.timer);
      this.timer = undefined;
      if (this.progress && this.progress.finishedAt === undefined) {
        this.timer = setInterval(() => {
          this.now = Date.now();
        }, 1000);
      }
      if (!this.progress && !this.busy) {
        this.dismiss();
      }
    }
    this.toggleAttribute("open", this.open && Boolean(this.progress));
  }

  dismiss(): void {
    this.pinned = false;
    this.open = false;
  }

  private readonly handleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.open) {
      this.dismiss();
      event.stopPropagation();
    }
  };

  private configurePopup(): void {
    const element = this.querySelector("wa-popup");
    const button = this.querySelector("button");
    if (element instanceof WaPopup && button) {
      configureAnchoredPopup(element, button, "bottom");
      element.distance = 16;
      element.hoverBridge = true;
    }
  }

  override render() {
    const progress = this.progress;
    const failed = progress?.finishedAt !== undefined;
    const active = Boolean(progress) || this.busy;
    const canInstall = !active || (progress?.canRetry === true && !this.busy);
    const duration = progress
      ? Math.max(0, Math.floor(((progress.finishedAt ?? this.now) - progress.startedAt) / 1000))
      : 0;
    return html`<span
      class="plugin-install-action"
      @mouseenter=${() => {
        this.hovering = true;
        this.open = true;
      }}
      @mouseleave=${() => {
        this.hovering = false;
        if (!this.pinned && !this.contains(document.activeElement)) {
          this.open = false;
        }
      }}
      @focusin=${() => {
        this.open = true;
      }}
      @focusout=${(event: FocusEvent) => {
        if (
          !this.pinned &&
          !this.hovering &&
          !(event.relatedTarget instanceof Node && this.contains(event.relatedTarget))
        ) {
          this.open = false;
        }
      }}
    >
      <button
        type="button"
        class=${`${this.buttonClass} plugin-install-action__button ${this.primary && !failed ? "primary oc-action-primary" : "oc-action-secondary"} ${failed ? "plugin-install-action__button--failed" : ""}`}
        ?disabled=${this.disabled && canInstall}
        aria-label=${
          this.pluginName && (canInstall || failed)
            ? t(
                canInstall
                  ? failed
                    ? "pluginsPage.retryInstallNamed"
                    : "pluginsPage.installNamed"
                  : "pluginsPage.viewInstallStatusNamed",
                { name: this.pluginName },
              )
            : nothing
        }
        aria-busy=${active && !failed ? "true" : nothing}
        aria-expanded=${progress ? String(this.open) : nothing}
        aria-controls=${progress ? this.progressId : nothing}
        @click=${(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (canInstall) {
            if (!this.disabled) {
              this.onInstall();
            }
          } else {
            this.pinned = !this.pinned;
            this.open = this.pinned;
          }
        }}
      >
        ${active && !failed ? html`<span class="btn__spinner" aria-hidden="true"></span>` : nothing}
        ${t(canInstall ? (failed ? "pluginsPage.retryInstall" : "pluginsPage.install") : failed ? "pluginsPage.installProgress.viewStatus" : "pluginsPage.installing")}
        ${progress ? icons.chevronDown : nothing}
      </button>
      ${
        progress
          ? html`<wa-popup class="plugin-install-action__popup" ?active=${this.open}>
              <section
                class="plugin-install-progress"
                id=${this.progressId}
                role="status"
                aria-label=${t("pluginsPage.installProgress.title")}
              >
                <div class="plugin-install-progress__header">
                  <strong
                    >${progress.failure?.title ?? t(failed ? "pluginsPage.installProgress.stopped" : "pluginsPage.installProgress.title")}</strong
                  ><span aria-hidden="true"
                    >${formatUnit({ value: duration, unit: "second" })}</span
                  >
                </div>
                ${progress.failure ? html`<p class="plugin-install-progress__recovery">${progress.failure.recovery}</p>` : nothing}
                <ol class="plugin-install-progress__activities">
                  ${progress.activities.map(
                    (activity) => html`<li
                      class=${`plugin-install-progress__activity plugin-install-progress__activity--${activity.status}`}
                    >
                      <span class="plugin-install-progress__icon" aria-hidden="true"
                        >${activity.status === "completed" ? icons.check : activity.status === "failed" ? "!" : nothing}</span
                      >
                      <span
                        >${t(`pluginsPage.installProgress.${activity.stage}.${activity.status}`)}</span
                      >
                    </li>`,
                  )}
                  ${failed && !progress.activities.some((activity) => activity.status === "failed") ? html`<li class="plugin-install-progress__activity plugin-install-progress__activity--failed"><span class="plugin-install-progress__icon" aria-hidden="true">!</span><span>${t("pluginsPage.installProgress.failure")}</span></li>` : nothing}
                </ol>
                ${
                  progress.failure
                    ? html`<details class="plugin-install-progress__failure">
                        <summary>${t("pluginsPage.installProgress.details")}</summary>
                        <p>${progress.failure.detail}</p>
                      </details>`
                    : nothing
                }
              </section>
            </wa-popup>`
          : nothing
      }
    </span>`;
  }
}
if (!customElements.get("openclaw-plugin-install-action")) {
  customElements.define("openclaw-plugin-install-action", PluginInstallAction);
}
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-install-action": PluginInstallAction;
  }
}
