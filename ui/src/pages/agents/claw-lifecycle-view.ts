import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsRow, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import {
  hasCompleteClawDisclosures,
  renderClawAccessReview,
} from "../agents-home/claws-access-review.ts";
import type { ClawCatalogDetail, ClawStatusRecord } from "../agents-home/claws-catalog-client.ts";
import {
  pluginAcknowledgements,
  renderClawPluginReviews,
} from "../agents-home/claws-plugin-review.ts";
import "../../styles/claw-lifecycle.css";
import type {
  ClawLifecyclePlan,
  ClawRemoveResult,
  ClawUpdatePlan,
  ClawUpdateResult,
} from "./claw-lifecycle-client.ts";

type AgentClawPanelProps = {
  available: boolean;
  record: ClawStatusRecord | null;
  statusLoading: boolean;
  statusError: string | null;
  canRemove: boolean;
  showUpdate: boolean;
  canUpdate: boolean;
  updateReviewOpen: boolean;
  updateDetail: ClawCatalogDetail | null;
  updatePlan: ClawUpdatePlan | null;
  updateLoading: boolean;
  updateError: string | null;
  updating: boolean;
  updateResult: ClawUpdateResult | null;
  updateUnknown: boolean;
  updateStatusChecking: boolean;
  updateClawHubRiskAccepted: boolean;
  acceptedPluginRisks: ReadonlySet<string>;
  reviewOpen: boolean;
  plan: ClawLifecyclePlan | null;
  planLoading: boolean;
  planError: string | null;
  removing: boolean;
  removeResult: ClawRemoveResult | null;
  removeUnknown: boolean;
  statusChecking: boolean;
  onRefresh: () => void;
  onRemove: () => void;
  onCloseReview: () => void;
  onRetryPlan: () => void;
  onConfirmRemove: () => void;
  onCheckStatus: () => void;
  onUpdate: () => void;
  onCloseUpdateReview: () => void;
  onRetryUpdatePlan: () => void;
  onConfirmUpdate: () => void;
  onCheckUpdateStatus: () => void;
  onUpdateClawHubRiskAcknowledged: (checked: boolean) => void;
  onUpdatePluginRiskAcknowledged: (key: string, checked: boolean) => void;
};

function labelState(value: string): string {
  return value.replaceAll(/[_-]/g, " ");
}

function labelAction(value: string): string {
  const label = labelState(value);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function renderResult(props: AgentClawPanelProps) {
  if (props.removeUnknown) {
    return html`<div class="callout warn" role="status">
      <strong>${t("clawsLifecycle.outcomeUnknown")}</strong>
      <p>${t("clawsLifecycle.checkBeforeRetry")}</p>
      <button class="btn btn--sm" ?disabled=${props.statusChecking} @click=${props.onCheckStatus}>
        ${
          props.statusChecking
            ? t("clawsLifecycle.checkingStatus")
            : t("clawsLifecycle.checkStatus")
        }
      </button>
    </div>`;
  }
  if (
    !props.removeResult ||
    (props.removeResult.status === "complete" && props.removeResult.agentRemoved)
  ) {
    return nothing;
  }
  return html`<div class="callout warn" role="status">
    <strong>${t("clawsLifecycle.incomplete")}</strong>
    <p>${t("clawsLifecycle.incompleteDetail")}</p>
    ${props.removeResult.error ? html`<p>${props.removeResult.error.message}</p>` : nothing}
    ${props.removeResult.warnings?.map((warning) => html`<p>${warning}</p>`)}
  </div>`;
}

function renderUpdateResult(props: AgentClawPanelProps) {
  if (props.updateUnknown) {
    return html`<div class="callout warn" role="status">
      <strong>${t("clawsLifecycle.updateOutcomeUnknown")}</strong>
      <p>${t("clawsLifecycle.updateCheckBeforeRetry")}</p>
      <button
        class="btn btn--sm"
        ?disabled=${props.updateStatusChecking}
        @click=${props.onCheckUpdateStatus}
      >
        ${
          props.updateStatusChecking
            ? t("clawsLifecycle.checkingStatus")
            : t("clawsLifecycle.checkStatus")
        }
      </button>
    </div>`;
  }
  const result = props.updateResult;
  if (!result) {
    return nothing;
  }
  const ready = result.status === "complete" && result.readiness.ready;
  return html`<div class="callout ${ready ? "success" : "warn"}" role="status">
    <strong
      >${ready ? t("clawsLifecycle.updated") : t("clawsLifecycle.updateNeedsAttention")}</strong
    >
    <p>
      ${ready ? t("clawsLifecycle.updatedDetail") : t("clawsLifecycle.updateNeedsAttentionDetail")}
    </p>
    ${result.error ? html`<p>${result.error.message}</p>` : nothing}
    ${
      result.readiness.requirements?.length
        ? html`<ul>
            ${result.readiness.requirements.map(
              (requirement) => html`<li>${requirement.kind}: ${requirement.owner}</li>`,
            )}
          </ul>`
        : nothing
    }
  </div>`;
}

function renderUpdateReview(props: AgentClawPanelProps) {
  if (!props.updateReviewOpen) {
    return nothing;
  }
  const plan = props.updatePlan;
  const detail = props.updateDetail;
  const record = props.record;
  const blocked = Boolean(plan?.blockers.length || plan?.actions.some((action) => action.blocked));
  const canConfirm =
    props.canUpdate &&
    Boolean(plan && detail && record) &&
    !blocked &&
    !props.updateLoading &&
    !props.updateError &&
    !props.updating &&
    !props.updateUnknown &&
    !props.updateResult &&
    plan?.target.agentId === record?.agentId &&
    plan?.target.currentVersion === record?.version &&
    plan?.target.targetVersion === detail?.version &&
    hasCompleteClawDisclosures(plan) &&
    (!plan?.riskAcknowledgementRequired || props.updateClawHubRiskAccepted) &&
    pluginAcknowledgements(plan?.pluginReviews, props.acceptedPluginRisks) !== null;
  return html`<openclaw-modal-dialog
    label=${t("clawsLifecycle.reviewUpdate")}
    style="--openclaw-modal-width: min(680px, calc(100vw - 24px));"
    @modal-cancel=${(event: Event) => {
      if (props.updating) {
        event.preventDefault();
      } else {
        props.onCloseUpdateReview();
      }
    }}
  >
    <section class="claw-lifecycle-dialog oc-card" aria-label=${t("clawsLifecycle.reviewUpdate")}>
      <header class="claw-lifecycle-dialog__header">
        <h2>${t("clawsLifecycle.reviewUpdate")}</h2>
        <button
          class="btn btn--icon"
          type="button"
          aria-label=${t("clawsLifecycle.close")}
          title=${t("clawsLifecycle.close")}
          ?disabled=${props.updating}
          @click=${props.onCloseUpdateReview}
        >
          ${icons.x}
        </button>
      </header>
      <div class="claw-lifecycle-dialog__body">
        ${
          props.updateLoading
            ? html`<p role="status">${t("clawsLifecycle.checkingUpdate")}</p>`
            : nothing
        }
        ${
          props.updateError
            ? html`<div class="callout danger" role="alert">
                ${props.updateError}
                <button class="btn btn--sm" @click=${props.onRetryUpdatePlan}>
                  ${t("clawsLifecycle.retry")}
                </button>
              </div>`
            : nothing
        }
        ${
          detail
            ? html`<div class="claw-lifecycle-dialog__identity">
                <strong>${detail.agentName ?? record?.name ?? detail.packageName}</strong>
                <span
                  >${t("clawsLifecycle.versionChange", { from: record?.version ?? "", to: detail.version })}</span
                >
              </div>`
            : nothing
        }
        ${
          detail && record?.version === detail.version
            ? html`<div class="callout success" role="status">${t("clawsLifecycle.upToDate")}</div>`
            : nothing
        }
        ${
          !props.showUpdate && plan
            ? html`<div class="callout warn" role="status">
                ${t("clawsLifecycle.updateLabsOff")}
              </div>`
            : nothing
        }
        ${
          plan
            ? html`
                <h3>${t("clawsLifecycle.updateChanges")}</h3>
                <ul class="claw-lifecycle-dialog__actions">
                  ${plan.actions.map(
                    (action) => html`<li>
                      <div>
                        <strong>${labelAction(action.action)} ${labelState(action.kind)}</strong>
                        <span>${action.id}</span>
                        ${action.reason ? html`<span>${action.reason}</span>` : nothing}
                      </div>
                    </li>`,
                  )}
                </ul>
                <h3>${t("clawsLifecycle.updateCapabilities")}</h3>
                ${
                  plan.capabilities.length
                    ? html`<ul class="claw-lifecycle-dialog__actions">
                        ${plan.capabilities.map(
                          (capability) => html`<li>
                            <div>
                              <strong
                                >${labelAction(capability.action)}
                                ${labelState(capability.kind)}</strong
                              >
                              <span>${capability.id} · ${capability.reason}</span>
                            </div>
                          </li>`,
                        )}
                      </ul>`
                    : html`<p class="claw-lifecycle-dialog__note">
                        ${t("clawsCatalog.noCapabilities")}
                      </p>`
                }
                ${renderClawAccessReview(plan)}
                ${
                  Array.isArray(plan.pluginReviews)
                    ? renderClawPluginReviews({
                        reviews: plan.pluginReviews,
                        acceptedRiskWarnings: props.acceptedPluginRisks,
                        onRiskAcknowledged: props.onUpdatePluginRiskAcknowledged,
                      })
                    : html`<div class="callout danger" role="alert">
                        ${t("clawsCatalog.pluginReviewUnavailable")}
                      </div>`
                }
                ${
                  plan.blockers.length
                    ? html`<div class="callout danger" role="alert">
                        <strong>${t("clawsLifecycle.updateBlockers")}</strong>
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
                            (requirement) =>
                              html`<li>${requirement.kind}: ${requirement.owner}</li>`,
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
                    ? html`<label class="claw-lifecycle-dialog__risk">
                        <input
                          type="checkbox"
                          .checked=${props.updateClawHubRiskAccepted}
                          @change=${(event: Event) => {
                            const target = event.currentTarget;
                            if (target instanceof HTMLInputElement) {
                              props.onUpdateClawHubRiskAcknowledged(target.checked);
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
        ${renderUpdateResult(props)}
      </div>
      <footer class="claw-lifecycle-dialog__footer">
        <button
          class="btn"
          type="button"
          ?disabled=${props.updating}
          @click=${props.onCloseUpdateReview}
        >
          ${t("clawsLifecycle.close")}
        </button>
        ${
          props.updateResult ||
          props.updateUnknown ||
          (detail && record?.version === detail.version)
            ? nothing
            : html`<button
                class="btn primary"
                type="button"
                data-claw-update-confirm
                ?disabled=${!canConfirm}
                @click=${props.onConfirmUpdate}
              >
                ${props.updating ? t("clawsLifecycle.updating") : t("clawsLifecycle.confirmUpdate")}
              </button>`
        }
      </footer>
    </section>
  </openclaw-modal-dialog>`;
}

function renderReview(props: AgentClawPanelProps) {
  if (!props.reviewOpen) {
    return nothing;
  }
  const plan = props.plan;
  const blocked = Boolean(plan?.blockers.length || plan?.actions.some((action) => action.blocked));
  const canConfirm =
    props.canRemove &&
    Boolean(plan) &&
    !blocked &&
    !props.planLoading &&
    !props.planError &&
    !props.removing &&
    !props.removeUnknown &&
    !props.removeResult &&
    !plan?.riskAcknowledgementRequired;
  return html`<openclaw-modal-dialog
    label=${t("clawsLifecycle.reviewRemove")}
    style="--openclaw-modal-width: min(680px, calc(100vw - 24px));"
    @modal-cancel=${(event: Event) => {
      if (props.removing) {
        event.preventDefault();
      } else {
        props.onCloseReview();
      }
    }}
  >
    <section class="claw-lifecycle-dialog oc-card" aria-label=${t("clawsLifecycle.reviewRemove")}>
      <header class="claw-lifecycle-dialog__header">
        <h2>${t("clawsLifecycle.reviewRemove")}</h2>
        <button
          class="btn btn--icon"
          type="button"
          aria-label=${t("clawsLifecycle.close")}
          title=${t("clawsLifecycle.close")}
          ?disabled=${props.removing}
          @click=${props.onCloseReview}
        >
          ${icons.x}
        </button>
      </header>
      <div class="claw-lifecycle-dialog__body">
        ${props.planLoading ? html`<p role="status">${t("clawsLifecycle.checkingPlan")}</p>` : nothing}
        ${
          props.planError
            ? html`<div class="callout danger" role="alert">
                ${props.planError}
                <button class="btn btn--sm" @click=${props.onRetryPlan}>
                  ${t("clawsLifecycle.retry")}
                </button>
              </div>`
            : nothing
        }
        ${
          plan
            ? html`
                <div class="claw-lifecycle-dialog__identity">
                  <strong>${plan.target.name ?? props.record?.name ?? ""}</strong>
                  <span
                    >${t("clawsLifecycle.version", { version: plan.target.currentVersion ?? props.record?.version ?? "" })}</span
                  >
                </div>
                <p class="claw-lifecycle-dialog__note">${t("clawsLifecycle.removeSummary")}</p>
                <h3>${t("clawsLifecycle.changes")}</h3>
                <ul class="claw-lifecycle-dialog__actions">
                  ${plan.actions.map(
                    (action) => html`<li>
                      <div>
                        <strong>${labelAction(action.action)} ${labelState(action.kind)}</strong>
                        <span>${action.id}</span>
                        ${action.reason ? html`<span>${action.reason}</span>` : nothing}
                      </div>
                      ${
                        action.action === "retain"
                          ? html`<span class="claw-lifecycle-dialog__retained"
                              >${t("clawsLifecycle.kept")}</span
                            >`
                          : nothing
                      }
                    </li>`,
                  )}
                </ul>
                ${
                  plan.blockers.length
                    ? html`<div class="callout danger" role="alert">
                        <strong>${t("clawsLifecycle.blockers")}</strong>
                        <ul>
                          ${plan.blockers.map((blocker) => html`<li>${blocker.message}</li>`)}
                        </ul>
                      </div>`
                    : nothing
                }
                ${plan.trustWarning ? html`<div class="callout warn" role="alert">${plan.trustWarning}</div>` : nothing}
              `
            : nothing
        }
        ${renderResult(props)}
      </div>
      <footer class="claw-lifecycle-dialog__footer">
        <button class="btn" type="button" ?disabled=${props.removing} @click=${props.onCloseReview}>
          ${t("clawsLifecycle.close")}
        </button>
        ${
          props.removeResult || props.removeUnknown
            ? nothing
            : html`<button
                class="btn danger"
                type="button"
                data-claw-remove-confirm
                ?disabled=${!canConfirm}
                @click=${props.onConfirmRemove}
              >
                ${props.removing ? t("clawsLifecycle.removing") : t("clawsLifecycle.confirmRemove")}
              </button>`
        }
      </footer>
    </section>
  </openclaw-modal-dialog>`;
}

export function renderAgentClawPanel(props: AgentClawPanelProps) {
  if (
    !props.available ||
    (!props.record &&
      !props.statusLoading &&
      !props.statusError &&
      !props.removeResult &&
      !props.removeUnknown &&
      !props.updateResult &&
      !props.updateUnknown)
  ) {
    return nothing;
  }
  const record = props.record;
  return html`
    ${renderSettingsSection(
      {
        title: t("clawsLifecycle.title"),
        description: record?.name ?? t("clawsLifecycle.description"),
        actions: html`<button
          type="button"
          class="btn btn--sm"
          ?disabled=${props.statusLoading}
          @click=${props.onRefresh}
        >
          ${t("clawsLifecycle.refresh")}
        </button>`,
        notice: html`
          ${props.statusError ? html`<div class="callout danger" role="alert">${props.statusError}</div>` : nothing}
          ${record?.orphaned ? html`<div class="callout warn" role="status">${t("clawsLifecycle.orphaned")}</div>` : nothing}
          ${props.reviewOpen ? nothing : renderResult(props)}
          ${props.updateReviewOpen ? nothing : renderUpdateResult(props)}
        `,
      },
      html`
        ${
          props.statusLoading && !record
            ? renderSettingsRow({ title: t("clawsLifecycle.loading") })
            : nothing
        }
        ${
          record
            ? html`
                ${renderSettingsRow({
                  title: t("clawsLifecycle.version", { version: record.version }),
                  description:
                    record.sourceKind === "package"
                      ? t("clawsLifecycle.sourceClawHub")
                      : t("clawsLifecycle.sourceLocal"),
                  control: html`<span
                    class="claw-lifecycle__state"
                    data-claw-status=${record.status}
                    >${labelState(record.status)}</span
                  >`,
                })}
                ${renderSettingsRow({
                  title: t("clawsLifecycle.health"),
                  description: t("clawsLifecycle.healthDetail", {
                    agent: labelState(record.agentState),
                    bootstrap: labelState(record.bootstrapState),
                  }),
                })}
                ${record.resources.map((resource) =>
                  renderSettingsRow({
                    title: resource.id,
                    description: html`
                      ${labelState(resource.kind)} ·
                      ${resource.relationship === "referenced" ? t("clawsLifecycle.referenced") : t("clawsLifecycle.managed")}
                      ${resource.origin === "pre-existing" ? ` · ${t("clawsLifecycle.preExisting")}` : ""}
                      ${resource.independentOwner ? ` · ${t("clawsLifecycle.shared")}` : ""}
                      ${resource.reason ? html`<span class="claw-lifecycle__reason">${resource.reason}</span>` : nothing}
                    `,
                    control: html`<span class="claw-lifecycle__state"
                      >${labelState(resource.state)}</span
                    >`,
                  }),
                )}
                ${
                  props.showUpdate
                    ? renderSettingsRow({
                        title: t("clawsLifecycle.updateTitle"),
                        description: t("clawsLifecycle.updateDescription"),
                        control: html`<button
                          type="button"
                          class="btn"
                          data-claw-update
                          ?disabled=${!props.canUpdate || props.updateReviewOpen}
                          @click=${props.onUpdate}
                        >
                          ${t("clawsLifecycle.checkUpdate")}
                        </button>`,
                      })
                    : nothing
                }
                ${renderSettingsRow({
                  title: t("clawsLifecycle.removeTitle"),
                  description: t("clawsLifecycle.removeDescription"),
                  control: html`<button
                    type="button"
                    class="btn danger"
                    ?disabled=${!props.canRemove || props.removeUnknown || Boolean(props.removeResult)}
                    title=${!props.canRemove ? t("clawsLifecycle.adminRequired") : ""}
                    @click=${props.onRemove}
                  >
                    ${t("clawsLifecycle.remove")}
                  </button>`,
                })}
              `
            : nothing
        }
      `,
    )}
    ${renderReview(props)} ${renderUpdateReview(props)}
  `;
}
