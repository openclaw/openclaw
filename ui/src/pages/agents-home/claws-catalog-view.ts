import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { hasCompleteClawDisclosures, renderClawAccessReview } from "./claws-access-review.ts";
import type {
  ClawAddApplyResult,
  ClawAddPlan,
  ClawCatalogDetail,
  ClawCatalogEntry,
} from "./claws-catalog-client.ts";
import { hasCompleteClawActionEffects, renderClawActionEffect } from "./claws-effect-review.ts";
import { pluginAcknowledgements, renderClawPluginReviews } from "./claws-plugin-review.ts";
import { skillAcknowledgements, renderClawSkillReviews } from "./claws-skill-review.ts";
import "../../styles/claws-catalog.css";

export type ClawsCatalogViewProps = {
  entries: ClawCatalogEntry[];
  query: string;
  loading: boolean;
  error: string | null;
  selected: ClawCatalogEntry | null;
  detail: ClawCatalogDetail | null;
  plan: ClawAddPlan | null;
  reviewLoading: boolean;
  reviewError: string | null;
  applying: boolean;
  applyResult: ClawAddApplyResult | null;
  applyUnknown: boolean;
  statusChecking: boolean;
  riskAcknowledged: boolean;
  acceptedPluginRisks: ReadonlySet<string>;
  acceptedSkillWarnings: ReadonlySet<string>;
  canAdd: boolean;
  onSearch: (query: string) => void;
  onSelect: (entry: ClawCatalogEntry) => void;
  onBack: () => void;
  onClose: () => void;
  onRetryCatalog: () => void;
  onRetryReview: () => void;
  onRiskAcknowledged: (checked: boolean) => void;
  onPluginRiskAcknowledged: (key: string, checked: boolean) => void;
  onSkillRiskAcknowledged: (key: string, checked: boolean) => void;
  onConfirm: () => void;
  onCheckStatus: () => void;
};

function renderCatalogList(props: ClawsCatalogViewProps) {
  return html`
    <label class="claws-catalog__search">
      <span class="claws-catalog__search-icon" aria-hidden="true">${icons.search}</span>
      <input
        type="search"
        data-claws-search
        autofocus
        aria-label=${t("clawsCatalog.search")}
        placeholder=${t("clawsCatalog.searchPlaceholder")}
        .value=${props.query}
        @input=${(event: InputEvent) => {
          const target = event.currentTarget;
          if (target instanceof HTMLInputElement) {
            props.onSearch(target.value);
          }
        }}
      />
    </label>
    ${
      props.error
        ? html`<div class="callout danger" role="alert">
            ${props.error}
            <button class="btn btn--sm" @click=${props.onRetryCatalog}>
              ${t("clawsCatalog.retry")}
            </button>
          </div>`
        : nothing
    }
    ${props.loading ? html`<p role="status">${t("clawsCatalog.loading")}</p>` : nothing}
    ${
      !props.loading && !props.error && props.entries.length === 0
        ? html`<p class="claws-catalog__empty">${t("clawsCatalog.empty")}</p>`
        : nothing
    }
    <ul class="claws-catalog__list">
      ${repeat(
        props.entries,
        (entry) => entry.packageName,
        (entry) => html`<li data-claws-entry>
          <div class="claws-catalog__entry-copy">
            <h3>${entry.displayName}</h3>
            ${entry.summary ? html`<p>${entry.summary}</p>` : nothing}
            <span class="claws-catalog__meta">${entry.packageName}</span>
          </div>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${!entry.latestVersion}
            title=${entry.latestVersion ? t("clawsCatalog.review") : t("clawsCatalog.noVersion")}
            @click=${() => props.onSelect(entry)}
          >
            ${t("clawsCatalog.add")}
          </button>
        </li>`,
      )}
    </ul>
  `;
}

function renderResourceCounts(detail: ClawCatalogDetail) {
  const rows = [
    ["files", detail.workspaceFiles],
    ["skills", detail.skills],
    ["plugins", detail.plugins],
    ["mcpServers", detail.mcpServers],
    ["schedules", detail.scheduledJobs],
  ] as const;
  return html`<div class="claws-catalog__resource-counts">
    ${rows.map(([key, count]) => html`<span>${t(`clawsCatalog.${key}`, { count: String(count) })}</span>`)}
  </div>`;
}

function renderReview(props: ClawsCatalogViewProps) {
  const selected = props.selected;
  if (!selected) {
    return nothing;
  }
  const detail = props.detail;
  const plan = props.plan;
  const blocked = Boolean(plan?.blockers.length || plan?.actions.some((action) => action.blocked));
  const effectsComplete = hasCompleteClawActionEffects(plan);
  const canConfirm =
    props.canAdd &&
    !props.applying &&
    !props.reviewLoading &&
    !props.reviewError &&
    !props.applyResult &&
    !props.applyUnknown &&
    !blocked &&
    Boolean(detail && plan) &&
    hasCompleteClawDisclosures(plan) &&
    effectsComplete &&
    (!plan?.riskAcknowledgementRequired || props.riskAcknowledged) &&
    pluginAcknowledgements(plan?.pluginReviews, props.acceptedPluginRisks) !== null &&
    skillAcknowledgements(plan?.skillReviews, props.acceptedSkillWarnings) !== null;
  return html`
    <div class="claws-catalog__review">
      <button
        type="button"
        class="claws-catalog__back"
        ?disabled=${props.applying || props.applyUnknown || Boolean(props.applyResult)}
        @click=${props.onBack}
      >
        ${icons.arrowLeft}<span>${t("clawsCatalog.back")}</span>
      </button>
      <div class="claws-catalog__identity">
        <h3>${detail?.agentName ?? selected.displayName}</h3>
        <p>${detail?.agentDescription ?? selected.summary ?? ""}</p>
        <div class="claws-catalog__meta">
          ${t("clawsCatalog.official")} · ${selected.packageName} ·
          ${t("clawsCatalog.version", { version: detail?.version ?? selected.latestVersion ?? "" })}
        </div>
      </div>
      ${
        props.reviewLoading
          ? html`<p role="status">${t("clawsCatalog.reviewLoading")}</p>`
          : nothing
      }
      ${
        props.reviewError
          ? html`<div class="callout danger" role="alert">
              ${props.reviewError}
              <button class="btn btn--sm" @click=${props.onRetryReview}>
                ${t("clawsCatalog.retry")}
              </button>
            </div>`
          : nothing
      }
      ${
        detail && plan
          ? html`
              <section class="claws-catalog__section">
                <h4>${t("clawsCatalog.contents")}</h4>
                ${renderResourceCounts(detail)}
              </section>
              <section class="claws-catalog__section">
                <h4>${t("clawsCatalog.changes")}</h4>
                <ul class="claws-catalog__facts">
                  ${plan.actions.map(
                    (action) => html`<li>
                      <strong>${action.action} ${action.kind}</strong>
                      <span>${action.id}${action.reason ? ` · ${action.reason}` : ""}</span>
                      ${renderClawActionEffect(action.effect)}
                    </li>`,
                  )}
                </ul>
                ${!effectsComplete ? html`<div class="callout danger" role="alert">${t("clawsEffectReview.unavailable")}</div>` : nothing}
              </section>
              <section class="claws-catalog__section">
                <h4>${t("clawsCatalog.capabilities")}</h4>
                ${
                  plan.capabilities.length
                    ? html`<ul class="claws-catalog__facts">
                        ${plan.capabilities.map(
                          (capability) => html`<li>
                            <strong
                              >${capability.action} ${capability.kind}: ${capability.id}</strong
                            >
                            <span>${capability.reason}</span>
                          </li>`,
                        )}
                      </ul>`
                    : html`<p>${t("clawsCatalog.noCapabilities")}</p>`
                }
              </section>
              ${renderClawAccessReview(plan)}
              ${
                Array.isArray(plan.pluginReviews)
                  ? renderClawPluginReviews({
                      reviews: plan.pluginReviews,
                      acceptedRiskWarnings: props.acceptedPluginRisks,
                      onRiskAcknowledged: props.onPluginRiskAcknowledged,
                    })
                  : html`<div class="callout danger" role="alert">
                      ${t("clawsCatalog.pluginReviewUnavailable")}
                    </div>`
              }
              ${
                Array.isArray(plan.skillReviews)
                  ? renderClawSkillReviews({
                      reviews: plan.skillReviews,
                      acceptedWarnings: props.acceptedSkillWarnings,
                      onRiskAcknowledged: props.onSkillRiskAcknowledged,
                    })
                  : html`<div class="callout danger" role="alert">
                      ${t("clawsCatalog.skillReviewUnavailable")}
                    </div>`
              }
              ${
                plan.blockers.length
                  ? html`<div class="callout danger" role="alert">
                      <strong>${t("clawsCatalog.blockers")}</strong>
                      <ul>
                        ${plan.blockers.map((blocker) => html`<li>${blocker.message}</li>`)}
                      </ul>
                    </div>`
                  : nothing
              }
              ${
                plan.readiness && !plan.readiness.ready
                  ? html`<div class="callout warn" role="status">
                      <strong>${t("clawsCatalog.needsSetup")}</strong>
                      <ul>
                        ${plan.readiness.requirements.map(
                          (requirement) => html`<li>${requirement.kind}: ${requirement.owner}</li>`,
                        )}
                      </ul>
                    </div>`
                  : nothing
              }
              ${
                plan.trustWarning
                  ? html`<div class="callout warn" role="alert">${plan.trustWarning}</div>`
                  : nothing
              }
              ${
                plan.riskAcknowledgementRequired
                  ? html`<label class="claws-catalog__risk">
                      <input
                        type="checkbox"
                        .checked=${props.riskAcknowledged}
                        @change=${(event: Event) => {
                          const target = event.currentTarget;
                          if (target instanceof HTMLInputElement) {
                            props.onRiskAcknowledged(target.checked);
                          }
                        }}
                      />
                      ${t("clawsCatalog.riskAcknowledgement")}
                    </label>`
                  : nothing
              }
            `
          : nothing
      }
      ${
        props.applyResult
          ? html`<div
              class="callout ${props.applyResult.readiness.ready && props.applyResult.status === "complete" ? "success" : "warn"}"
              role="status"
            >
              <strong>
                ${
                  props.applyResult.status === "complete"
                    ? props.applyResult.readiness.ready
                      ? t("clawsCatalog.added")
                      : t("clawsCatalog.needsSetup")
                    : t("clawsCatalog.incomplete")
                }
              </strong>
              <p>
                ${
                  props.applyResult.status === "complete"
                    ? props.applyResult.readiness.ready
                      ? t("clawsCatalog.openFromAgents")
                      : t("clawsCatalog.setupAfterAdd")
                    : t("clawsCatalog.incompleteAfterAdd")
                }
              </p>
              ${props.applyResult.error ? html`<p>${props.applyResult.error.message}</p>` : nothing}
              ${
                props.applyResult.readiness.requirements?.length
                  ? html`<ul>
                      ${props.applyResult.readiness.requirements.map(
                        (requirement) => html`<li>${requirement.kind}: ${requirement.owner}</li>`,
                      )}
                    </ul>`
                  : nothing
              }
            </div>`
          : nothing
      }
      ${
        props.applyUnknown
          ? html`<div class="callout warn" role="status">
              <strong>${t("clawsCatalog.outcomeUnknown")}</strong>
              <p>${t("clawsCatalog.checkBeforeRetry")}</p>
              <button
                class="btn btn--sm"
                ?disabled=${props.statusChecking}
                @click=${props.onCheckStatus}
              >
                ${props.statusChecking ? t("clawsCatalog.checkingStatus") : t("clawsCatalog.checkStatus")}
              </button>
            </div>`
          : nothing
      }
      <footer class="claws-catalog__footer">
        <button type="button" class="btn" ?disabled=${props.applying} @click=${props.onClose}>
          ${props.applyResult || props.applyUnknown ? t("clawsCatalog.done") : t("clawsCatalog.close")}
        </button>
        ${
          props.applyResult || props.applyUnknown
            ? nothing
            : html`<button
                type="button"
                class="btn primary"
                data-claws-confirm
                ?disabled=${!canConfirm}
                title=${!props.canAdd ? t("clawsCatalog.adminRequired") : ""}
                @click=${props.onConfirm}
              >
                ${props.applying ? t("clawsCatalog.adding") : t("clawsCatalog.confirm")}
              </button>`
        }
      </footer>
    </div>
  `;
}

export function renderClawsCatalogDialog(props: ClawsCatalogViewProps) {
  return html`<openclaw-modal-dialog
    label=${t("clawsCatalog.title")}
    style="--openclaw-modal-width: min(720px, calc(100vw - 24px));"
    @modal-cancel=${(event: Event) => {
      if (props.applying) {
        event.preventDefault();
      } else {
        props.onClose();
      }
    }}
  >
    <section class="claws-catalog oc-card" aria-label=${t("clawsCatalog.title")}>
      <header class="claws-catalog__header">
        <h2>${props.selected ? t("clawsCatalog.review") : t("clawsCatalog.title")}</h2>
        <button
          type="button"
          class="claws-catalog__close"
          aria-label=${t("clawsCatalog.close")}
          title=${t("clawsCatalog.close")}
          ?disabled=${props.applying}
          @click=${props.onClose}
        >
          ${icons.x}
        </button>
      </header>
      <div class="claws-catalog__body">
        ${props.selected ? renderReview(props) : renderCatalogList(props)}
      </div>
    </section>
  </openclaw-modal-dialog>`;
}
