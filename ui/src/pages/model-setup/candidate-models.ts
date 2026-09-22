import { html, nothing } from "lit";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { renderProviderIcon } from "./model-setup-icon-loader.ts";
import { activationTargetId, type ModelSetupActivationState } from "./state.ts";

registerModelSetupEnglish();

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type CandidateRowsProps = Parameters<typeof renderProviderIcon>[0] & {
  activation: ModelSetupActivationState;
  actionsDisabled: boolean;
  onActivateCandidate: (candidate: Candidate) => void;
};

function candidateStatus(candidate: Candidate): string {
  if (candidate.modelTarget === "utility") {
    return t("modelSetup.utility.role");
  }
  const status = candidate.kind.startsWith("saved-auth:")
    ? "detected"
    : candidate.recommended
      ? "recommended"
      : candidate.credentials === undefined
        ? "detected"
        : candidate.credentials
          ? "credentialsReady"
          : "signInNeeded";
  return t(`modelSetup.candidates.${status}`);
}

export function renderCandidateRows(
  props: CandidateRowsProps,
  result: SystemAgentSetupDetectResult,
) {
  // Saved credentials can replace the current connection for the same model.
  const candidates = result.candidates.filter(
    (candidate) =>
      !(
        candidate.modelTarget === "utility" &&
        !candidate.kind.startsWith("saved-auth:") &&
        candidate.modelRef === (result.utilityModel ?? result.setupModel)
      ) &&
      (!result.configuredModel ||
        (candidate.kind !== "existing-model" &&
          (candidate.kind.startsWith("saved-auth:") ||
            candidate.modelRef !== result.configuredModel))),
  );
  if (candidates.length === 0) {
    return nothing;
  }
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.candidates.title")}</h2>
      </div>
      <div class="model-setup__rows">
        ${candidates
          .toSorted((a, b) => a.label.localeCompare(b.label))
          .map((candidate) => {
            const testing =
              props.activation.phase === "testing" &&
              props.activation.targetId === activationTargetId(candidate.kind, candidate.modelRef);
            const failure =
              props.activation.phase === "failure" &&
              props.activation.targetId === activationTargetId(candidate.kind, candidate.modelRef)
                ? props.activation
                : null;
            return html`
              <div class="model-setup__row" data-candidate-kind=${candidate.kind}>
                <div class="model-setup__row-main">
                  <div class="model-setup__row-title">
                    ${renderProviderIcon(props, candidate)}
                    <strong>${candidate.label}</strong>
                    <span class="model-setup__chip">${candidateStatus(candidate)}</span>
                  </div>
                  <div class="muted">
                    ${candidate.modelRef} · ${formatUiExternalText(candidate.detail)}
                  </div>
                  ${
                    candidate.modelTarget === "utility"
                      ? html`<div class="muted">${t("modelSetup.utility.hint")}</div>`
                      : nothing
                  }
                </div>
                <div class="model-setup__row-actions">
                  <button
                    type="button"
                    class=${`btn ${failure ? "" : "primary"}`}
                    ?disabled=${props.actionsDisabled}
                    @click=${() => props.onActivateCandidate(candidate)}
                  >
                    <span>
                      ${
                        testing
                          ? t("modelSetup.candidates.testingButton")
                          : failure
                            ? t("modelSetup.candidates.retry")
                            : candidate.modelTarget === "utility"
                              ? t(
                                  result.configuredModel
                                    ? "modelSetup.utility.useUtility"
                                    : "modelSetup.utility.useSetup",
                                )
                              : t("modelSetup.candidates.testAndUse")
                      }
                    </span>
                  </button>
                </div>
              </div>
            `;
          })}
      </div>
    </section>
  `;
}
