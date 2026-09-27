import { initialState, Task, TaskStatus } from "@lit/task";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

export class ModelAccountUsage extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() agentId = "";
  @property() profileId = "";
  @state() private refresh = 0;

  private readonly usage = new Task(this, {
    args: () => [this.client, this.agentId, this.profileId, this.refresh] as const,
    task: ([client, agentId, profileId], { signal }) =>
      client && agentId && profileId
        ? client.request<UsageSummary>(
            "codex.accountUsage",
            { agentId, profileId },
            { signal, timeoutMs: 30_000 },
          )
        : initialState,
  });

  refreshUsage(): void {
    this.refresh += 1;
  }

  override render() {
    if (!this.client) {
      return nothing;
    }
    return html`
      <div class="model-providers__account-usage">
        <button
          class="model-providers__account-refresh"
          type="button"
          aria-label=${t("common.refresh")}
          title=${t("common.refresh")}
          ?disabled=${this.usage.status === TaskStatus.PENDING}
          @click=${() => this.refreshUsage()}
        >
          ${icons.refresh}
        </button>
        ${this.usage.render({
          pending: () => html`<span>${t("common.loading")}</span>`,
          complete: (summary) =>
            summary.providers.length === 0
              ? html`<span>${t("modelProviders.noStats")}</span>`
              : summary.providers.map(
                  (snapshot) => html`
                    ${snapshot.plan ? html`<strong>${snapshot.plan}</strong>` : nothing}
                    <div>
                      ${
                        snapshot.windows.length || snapshot.billing?.length
                          ? renderProviderUsageDetails(snapshot, { groupWindows: true })
                          : t("modelProviders.noStats")
                      }
                    </div>
                  `,
                ),
          error: (error) => html`<span class="provider-usage-error">${formatUiError(error)}</span>`,
        })}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-model-account-usage")) {
  customElements.define("openclaw-model-account-usage", ModelAccountUsage);
}
