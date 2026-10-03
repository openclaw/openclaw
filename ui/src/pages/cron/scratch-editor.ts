import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { CronScratchGetResult, CronScratchSetResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

class CronScratchEditor extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @property({ attribute: false }) jobId = "";
  @state() private snapshot: CronScratchGetResult | null = null;
  @state() private draft = "";
  @state() private busy = false;
  @state() private message = "";
  @state() private conflict = false;
  @state() private redacted = false;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.reset(),
    onSnapshot: () => {
      if (!this.canManage) {
        this.gateway.invalidate();
        this.reset();
      }
    },
  });

  private reset() {
    this.snapshot = null;
    this.draft = "";
    this.busy = false;
    this.message = "";
    this.conflict = false;
    this.redacted = false;
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("jobId")) {
      this.gateway.invalidate();
      this.reset();
    }
  }

  private get canManage() {
    return this.context && readGatewayOperatorAccess(this.context.gateway.snapshot).canAdmin;
  }

  private get sizeBytes() {
    return new TextEncoder().encode(this.draft).length;
  }

  private accept(snapshot: CronScratchGetResult) {
    const content = snapshot.scratch?.content ?? "";
    this.draft = redactToolDetail(content);
    this.redacted = this.draft !== content;
    // Retain revision metadata only: raw scratch must not leak into diagnostics/state dumps.
    this.snapshot = {
      ...snapshot,
      scratch: snapshot.scratch ? { ...snapshot.scratch, content: "" } : null,
    };
    this.conflict = false;
  }

  private async request(content?: string | null) {
    const scope = this.gateway.capture();
    const client = this.gateway.client;
    const jobId = this.jobId;
    const saving = content !== undefined;
    const snapshot = this.snapshot;
    if (!scope || !client || !jobId || this.busy || !this.canManage) {
      return;
    }
    if (saving && (!this.canManage || !snapshot || this.conflict)) {
      return;
    }
    if (typeof content === "string" && this.redacted) {
      return;
    }
    if (typeof content === "string" && snapshot && this.sizeBytes > snapshot.maxBytes) {
      this.message = t("cron.scratch.tooLarge");
      return;
    }
    this.busy = true;
    this.message = "";
    try {
      const result = saving
        ? await client.request<CronScratchSetResult>("cron.scratch.set", {
            id: jobId,
            content,
            expectedRevision: snapshot?.currentRevision,
          })
        : await client.request<CronScratchGetResult>("cron.scratch.get", { id: jobId });
      if (!this.gateway.isCurrent(scope) || this.jobId !== jobId || !this.canManage) {
        return;
      }
      if ("reason" in result) {
        // Never adopt the conflicting revision while retaining an older draft: a retry would overwrite it.
        this.conflict = true;
        this.message = t("cron.scratch.conflict");
        return;
      }
      this.accept(result);
      if (saving) {
        this.message = t(content === null ? "cron.scratch.removed" : "cron.scratch.saved");
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && this.jobId === jobId) {
        this.message = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope) && this.jobId === jobId) {
        this.busy = false;
      }
    }
  }

  override render() {
    if (!this.canManage) {
      return nothing;
    }
    const disabled = this.busy || !this.gateway.connected || !this.canManage || this.conflict;
    return html`<section class="settings-section">
      <details>
        <summary class="settings-section__heading">${t("cron.scratch.title")}</summary>
        <p class="settings-section__desc">${t("cron.scratch.help")}</p>
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${this.busy || !this.gateway.connected}
          @click=${() => void this.request()}
        >
          ${t(this.snapshot ? "cron.scratch.reload" : "cron.scratch.load")}
        </button>
        ${
          this.snapshot
            ? html`
                ${
                  !this.snapshot.scratch
                    ? html`<p class="cron-help">${t("cron.scratch.empty")}</p>`
                    : nothing
                }
                <label class="field"
                  ><span>${t("cron.scratch.content")}</span>
                  <textarea
                    class="settings-input mono"
                    rows="8"
                    .value=${this.draft}
                    ?readonly=${disabled || this.redacted}
                    maxlength=${this.snapshot.maxBytes}
                    @input=${(event: Event) => {
                      // SAFETY: This synchronous listener is bound to the textarea; currentTarget is it.
                      this.draft = (event.currentTarget as HTMLTextAreaElement).value;
                    }}
                  ></textarea>
                </label>
                <p class="cron-help">
                  ${t("cron.scratch.limit", {
                    bytes: String(this.sizeBytes),
                    max: String(this.snapshot.maxBytes),
                  })}
                </p>
                ${
                  this.redacted
                    ? html`<p class="cron-help">${t("cron.scratch.redacted")}</p>`
                    : nothing
                }
                ${
                  this.canManage
                    ? html`
                        <button
                          class="btn btn--sm"
                          type="button"
                          ?disabled=${
                            disabled || this.redacted || this.sizeBytes > this.snapshot.maxBytes
                          }
                          @click=${() => void this.request(this.draft)}
                        >
                          ${t("cron.scratch.save")}
                        </button>
                        <button
                          class="btn btn--sm danger"
                          type="button"
                          ?disabled=${disabled || !this.snapshot.scratch}
                          @click=${() => void this.request(null)}
                        >
                          ${t("cron.scratch.clear")}
                        </button>
                      `
                    : nothing
                }
              `
            : nothing
        }
        ${this.message ? html`<p class="cron-help" role="status">${this.message}</p>` : nothing}
      </details>
    </section>`;
  }
}

if (!customElements.get("openclaw-cron-scratch-editor")) {
  customElements.define("openclaw-cron-scratch-editor", CronScratchEditor);
}
