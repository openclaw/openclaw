import { html, nothing, type TemplateResult } from "lit";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import {
  providerDisplayLabel,
  providerIdFromModelRef,
  renderProviderBrandIcon,
} from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import {
  activationTargetId,
  type ModelSetupActivationState,
  type ModelSetupVerifyState,
} from "./state.ts";

registerModelSetupEnglish();

type Candidate = SystemAgentSetupDetectResult["candidates"][number];

export function renderConfiguredUtilityModel(props: {
  result: SystemAgentSetupDetectResult;
  activation: ModelSetupActivationState;
  canRepair: boolean;
  actionsDisabled: boolean;
  onOpenAssistant: () => void;
  onActivateCandidate: (candidate: Candidate) => void;
}) {
  const modelRef = props.result.utilityModel ?? props.result.setupModel;
  if (!modelRef) {
    return nothing;
  }
  const repairCandidate = props.canRepair
    ? props.result.candidates.find(
        (candidate) =>
          candidate.modelTarget === "utility" &&
          candidate.modelRef === modelRef &&
          candidate.kind.startsWith("provider-auto:"),
      )
    : undefined;
  const repairing =
    repairCandidate &&
    props.activation.phase === "testing" &&
    props.activation.targetId ===
      activationTargetId(repairCandidate.kind, repairCandidate.modelRef);
  return html`<section class="settings-section model-setup__utility">
    <div class="settings-section__header"><h2>${t("modelSetup.utility.configured")}</h2></div>
    <div class="model-setup__row">
      <div class="model-setup__row-main">
        <strong>${modelRef}</strong>
        <div class="muted">
          ${t(
            props.result.configuredModel
              ? "modelSetup.utility.primaryReady"
              : "modelSetup.utility.choosePrimary",
          )}
        </div>
      </div>
      <div class="model-setup__row-actions">
        ${
          repairCandidate
            ? html`<button
                type="button"
                class="btn"
                ?disabled=${props.actionsDisabled}
                @click=${() => props.onActivateCandidate(repairCandidate)}
              >
                ${t(repairing ? "modelSetup.candidates.testingButton" : "modelSetup.utility.repair")}
              </button>`
            : nothing
        }
        <button
          type="button"
          class="btn primary"
          ?disabled=${props.actionsDisabled}
          @click=${props.onOpenAssistant}
        >
          ${t("modelSetup.utility.openAssistant")}
        </button>
      </div>
    </div>
  </section>`;
}

function failureLabel(status: string): string {
  const labels: Record<string, string> = {
    auth: t("modelSetup.failure.auth"),
    rate_limit: t("modelSetup.failure.rateLimit"),
    billing: t("modelSetup.failure.billing"),
    timeout: t("modelSetup.failure.timeout"),
    format: t("modelSetup.failure.format"),
    unavailable: t("modelSetup.failure.unavailable"),
    unknown: t("modelSetup.failure.unknown"),
  };
  return labels[status] ?? labels.unknown!;
}

function failureGuidance(status: string): string | typeof nothing {
  const guidance: Record<string, string | typeof nothing> = {
    auth: t("modelSetup.failureGuidance.auth"),
    rate_limit: t("modelSetup.failureGuidance.rateLimit"),
    billing: t("modelSetup.failureGuidance.billing"),
    timeout: t("modelSetup.failureGuidance.timeout"),
    format: t("modelSetup.failureGuidance.format"),
    unavailable: nothing,
    unknown: t("modelSetup.failureGuidance.unknown"),
  };
  return guidance[status] ?? guidance.unknown!;
}

function renderModelSetupFailure(status: string, error: string): TemplateResult {
  return html`
    <div class="model-setup__failure" role="alert">
      <span class="model-setup__failure-icon" aria-hidden="true">${icons.alertTriangle}</span>
      <span><strong>${failureLabel(status)}.</strong> ${error} ${failureGuidance(status)}</span>
    </div>
  `;
}

function modelName(modelRef: string): string {
  const separator = modelRef.indexOf("/");
  return separator < 0 ? modelRef : modelRef.slice(separator + 1);
}

function findConfiguredCandidate(
  result: SystemAgentSetupDetectResult,
  modelRef: string,
): Candidate | undefined {
  return result.candidates.find(
    (candidate) => candidate.modelRef === modelRef && !candidate.kind.startsWith("saved-auth:"),
  );
}

function configuredModelDetail(candidate: Candidate | undefined, modelRef: string): string {
  const name = modelName(modelRef);
  const detail = candidate?.detail.trim();
  if (!detail || candidate?.kind === "existing-model") {
    return name;
  }
  return detail.toLowerCase().includes(name.toLowerCase()) ? detail : `${name} · ${detail}`;
}

function verificationButtonLabel(verify: ModelSetupVerifyState): string {
  switch (verify.phase) {
    case "checking":
      return t("modelSetup.verify.checkingButton");
    case "failed":
      return t("modelSetup.verify.retry");
    case "ok":
      return t("modelSetup.verify.checkAgain");
    default:
      return t("modelSetup.verify.button");
  }
}

export function renderConfiguredModel(props: {
  result: SystemAgentSetupDetectResult;
  verify: ModelSetupVerifyState;
  canVerify: boolean;
  actionsDisabled: boolean;
  onVerify: () => void;
  onContinue?: () => void;
}): TemplateResult {
  const configuredRef = props.result.configuredModel!;
  // A successful verify reports the model that actually answered; prefer it over
  // the detect-time snapshot so concurrent config changes cannot mislabel the result.
  const displayRef = props.verify.phase === "ok" ? props.verify.modelRef : configuredRef;
  const providerId = providerIdFromModelRef(displayRef);
  const configuredCandidate =
    displayRef === configuredRef ? findConfiguredCandidate(props.result, configuredRef) : undefined;
  const providerLabel = providerId ? providerDisplayLabel(providerId) : displayRef;
  const detail = configuredModelDetail(configuredCandidate, displayRef);

  return html`
    <section class="settings-section model-setup__current" data-verify-phase=${props.verify.phase}>
      <div class="settings-section__header">
        <h2>${t("modelSetup.verify.title")}</h2>
      </div>
      <div class="model-setup__row">
        <div class="model-setup__provider-copy">
          ${
            providerId
              ? renderProviderBrandIcon(providerId, { className: "model-setup__icon" })
              : nothing
          }
          <div class="model-setup__current-copy">
            <strong>${providerLabel}</strong>
            <div class="muted">${detail}</div>
            ${
              props.verify.phase === "checking"
                ? html`<div class="model-setup__testing" role="status">
                    ${t("modelSetup.verify.checking", { modelRef: configuredRef })}
                  </div>`
                : props.verify.phase === "ok"
                  ? html`<div class="model-setup__verified" role="status">
                      ${
                        props.verify.latencyMs === undefined
                          ? t("modelSetup.verify.ready")
                          : t("modelSetup.verify.readyIn", {
                              latencyMs: String(props.verify.latencyMs),
                            })
                      }
                    </div>`
                  : props.verify.phase === "failed"
                    ? renderModelSetupFailure(props.verify.status, props.verify.error)
                    : nothing
            }
          </div>
        </div>
        <div class="model-setup__row-actions">
          ${
            props.canVerify
              ? html`<button
                  type="button"
                  class="btn"
                  ?disabled=${props.actionsDisabled}
                  @click=${props.onVerify}
                >
                  ${verificationButtonLabel(props.verify)}
                </button>`
              : nothing
          }
          ${
            props.onContinue
              ? html`<button type="button" class="btn primary" @click=${props.onContinue}>
                  ${icons.messageSquare} ${t("modelSetup.success.continueSetup")}
                </button>`
              : nothing
          }
        </div>
      </div>
    </section>
  `;
}

export function renderActivationFeedback(activation: ModelSetupActivationState) {
  // Feedback follows the activation attempt, including prepared models absent from discovery.
  if (activation.phase === "testing") {
    return html`<div class="model-setup__testing" role="status">${t("modelSetup.testing")}</div>`;
  }
  return activation.phase === "failure"
    ? renderModelSetupFailure(activation.status, activation.error)
    : nothing;
}
