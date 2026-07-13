// Control UI view renders the Model Providers settings page content.
import { html, nothing } from "lit";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatCost, formatTimeMs, formatTokens } from "../../lib/format.ts";
import "../../styles/model-providers.css";
import "../../styles/usage.css";
import type { ModelProviderAuthKind, ModelProviderCard } from "./data.ts";

type ModelProvidersViewProps = {
  connected: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  updatedAt: number | null;
  costDays: number;
  cards: ModelProviderCard[];
  onRefresh: () => void;
};

const AUTH_KIND_I18N: Record<ModelProviderAuthKind, string> = {
  ok: "modelProviders.status.ok",
  expiring: "modelProviders.status.expiring",
  expired: "modelProviders.status.expired",
  missing: "modelProviders.status.missing",
  "api-key": "modelProviders.status.apiKey",
};

const AUTH_KIND_STATUS: Record<ModelProviderAuthKind, "ok" | "warn" | "danger" | "muted"> = {
  ok: "ok",
  expiring: "warn",
  expired: "danger",
  missing: "danger",
  "api-key": "muted",
};

function renderAuthStatus(card: ModelProviderCard) {
  const auth = card.auth;
  if (!auth) {
    return nothing;
  }
  const label = t(AUTH_KIND_I18N[auth.kind]);
  const detail = auth.expiryLabel
    ? t("modelProviders.expiresIn", { time: auth.expiryLabel })
    : undefined;
  return html`
    <span title=${detail ?? label}>
      ${renderSettingsStatus({ kind: AUTH_KIND_STATUS[auth.kind], label })}
    </span>
  `;
}

function modelsText(card: ModelProviderCard): string | null {
  if (card.modelCount === 0) {
    return null;
  }
  return card.availableModelCount < card.modelCount
    ? t("modelProviders.modelsAvailable", {
        available: String(card.availableModelCount),
        count: String(card.modelCount),
      })
    : card.modelCount === 1
      ? t("modelProviders.modelOne")
      : t("modelProviders.models", { count: String(card.modelCount) });
}

// formatTokens tops out at "M"; month-scale provider totals can cross a
// billion tokens, which would render as e.g. "4132M".
function formatTokenTotal(tokens: number): string {
  if (tokens >= 1_000_000_000) {
    const billions = tokens / 1_000_000_000;
    return billions < 10 ? `${billions.toFixed(1)}B` : `${Math.round(billions)}B`;
  }
  return formatTokens(tokens);
}

function renderLocalCost(card: ModelProviderCard, costDays: number) {
  const cost = card.localCost;
  if (!cost || (cost.totalTokens === 0 && cost.totalCost === 0)) {
    return nothing;
  }
  return html`
    <div class="model-providers__local-cost">
      <div class="provider-usage-billing-row">
        <span>${t("modelProviders.localCost", { days: String(costDays) })}</span>
        <strong>${formatCost(cost.totalCost)}</strong>
      </div>
      <div class="model-providers__local-cost-detail">
        ${t("modelProviders.localCostDetail", {
          tokens: formatTokenTotal(cost.totalTokens),
          sessions: String(cost.sessionCount),
        })}
      </div>
    </div>
  `;
}

function renderProviderRow(card: ModelProviderCard, costDays: number) {
  const models = modelsText(card);
  return html`
    <div class="settings-row settings-row--stacked model-providers__row">
      <div class="model-providers__head">
        <div class="model-providers__identity">
          ${renderProviderBrandIcon(card.id, { className: "model-providers__icon" })}
          <div class="settings-row__text">
            <span class="settings-row__title">${card.displayName}</span>
            <span class="settings-row__desc"
              >${card.id}${models ? html` · ${models}` : nothing}</span
            >
          </div>
        </div>
        <div class="settings-row__control">
          ${card.usage?.plan ? renderSettingsValue(card.usage.plan) : nothing}
          ${renderAuthStatus(card)}
        </div>
      </div>
      ${card.usage
        ? renderProviderUsageDetails(card.usage)
        : html`<div class="model-providers__no-stats">${t("modelProviders.noStats")}</div>`}
      ${renderLocalCost(card, costDays)}
    </div>
  `;
}

export function renderModelProviders(props: ModelProvidersViewProps) {
  if (!props.connected) {
    return renderSettingsPage(
      renderSettingsGroup(renderSettingsEmpty(t("modelProviders.disconnected"))),
    );
  }
  if (props.loading) {
    return renderSettingsPage(
      html`<div aria-busy="true">
        ${renderSettingsGroup(renderSettingsEmpty(t("common.loading")))}
      </div>`,
    );
  }
  const rows = html`
    ${props.error
      ? html`
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__desc provider-usage-error">${props.error}</span>
            </div>
          </div>
        `
      : nothing}
    ${props.cards.length === 0
      ? renderSettingsEmpty(
          html`<strong>${t("modelProviders.emptyTitle")}</strong><br />${t(
              "modelProviders.emptySubtitle",
            )}`,
        )
      : props.cards.map((card) => renderProviderRow(card, props.costDays))}
  `;
  return renderSettingsPage(
    renderSettingsSection(
      {
        title: t("modelProviders.title"),
        description: props.updatedAt
          ? t("modelProviders.updated", { time: formatTimeMs(props.updatedAt) })
          : t("modelProviders.subtitle"),
        count: props.cards.length,
        actions: html`
          <button
            class="btn btn--sm"
            ?disabled=${props.refreshing}
            @click=${() => props.onRefresh()}
          >
            ${props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
          </button>
        `,
      },
      rows,
    ),
  );
}
