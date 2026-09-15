import { Task, TaskStatus } from "@lit/task";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

export type ModelAccountUsageProfile = {
  profileId: string;
  label: string;
};

type AccountUsageResult =
  | { profile: ModelAccountUsageProfile; summary: UsageSummary }
  | { profile: ModelAccountUsageProfile; error: unknown };

/**
 * Loads the OpenAI subscription accounts visible in one saved profile group.
 * A single task owns the group so one failed account never prevents the
 * sibling cards from publishing, and Task invalidates stale agent/client work.
 */
export class ModelAccountUsages extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() agentId = "";
  @property({ attribute: false }) profiles: readonly ModelAccountUsageProfile[] = [];
  @state() private refresh = 0;
  private profilesSnapshot: readonly ModelAccountUsageProfile[] = [];

  private readonly usage = new Task(this, {
    args: () =>
      [
        this.client,
        this.agentId,
        this.profiles.map((profile) => `${profile.profileId}\u0000${profile.label}`).join("\u0001"),
        this.refresh,
      ] as const,
    task: async ([client, agentId], { signal }): Promise<readonly AccountUsageResult[]> => {
      const profiles = this.profilesSnapshot;
      if (!client || !agentId || profiles.length === 0) {
        return [];
      }
      const settled = await Promise.allSettled(
        profiles.map(async (profile) => ({
          profile,
          summary: await client.request<UsageSummary>(
            "codex.accountUsage",
            { agentId, profileId: profile.profileId },
            { signal, timeoutMs: 30_000 },
          ),
        })),
      );
      return settled.map((result, index) =>
        result.status === "fulfilled"
          ? result.value
          : { profile: profiles[index]!, error: result.reason },
      );
    },
  });

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("profiles")) {
      this.profilesSnapshot = [...this.profiles];
    }
  }

  refreshUsage(): void {
    this.refresh += 1;
  }

  override render() {
    if (!this.client || this.profiles.length === 0) {
      return nothing;
    }
    return html`
      <div class="model-providers__account-usages">
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
          complete: (results) =>
            results.map((result) =>
              "error" in result
                ? html`<div class="model-providers__account-usage">
                    <strong>${result.profile.label}</strong>
                    <span class="provider-usage-error">${formatUiError(result.error)}</span>
                  </div>`
                : html`<div class="model-providers__account-usage">
                    <strong>${result.profile.label}</strong>
                    ${
                      result.summary.providers.length === 0
                        ? html`<span>${t("modelProviders.noStats")}</span>`
                        : result.summary.providers.map(
                            (snapshot) => html`
                              ${snapshot.plan ? html`<span>${snapshot.plan}</span>` : nothing}
                              ${
                                snapshot.windows.length || snapshot.billing?.length
                                  ? renderProviderUsageDetails(snapshot, { groupWindows: true })
                                  : html`<span>${t("modelProviders.noStats")}</span>`
                              }
                            `,
                          )
                    }
                  </div>`,
            ),
          error: (error) => html`<span class="provider-usage-error">${formatUiError(error)}</span>`,
        })}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-model-account-usages")) {
  customElements.define("openclaw-model-account-usages", ModelAccountUsages);
}
