import { For, Show, createMemo } from "solid-js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderProviderIcon } from "./model-setup-icon-loader.tsx";
import { activationTargetId, type ModelSetupActivationState } from "./state.ts";

registerModelSetupEnglish();

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
export type CandidateRowsProps = Parameters<typeof renderProviderIcon>[0] & {
  activation: ModelSetupActivationState;
  actionsDisabled: boolean;
  detecting?: boolean;
  embedded?: boolean;
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

export function CandidateRows(
  props: CandidateRowsProps & { result: SystemAgentSetupDetectResult },
) {
  // Saved credentials can replace the current connection for the same model.
  const candidates = createMemo(() => {
    const result = props.result;
    return result.candidates
      .filter(
        (candidate) =>
          candidate.kind.startsWith("saved-auth:") ||
          ((candidate.modelTarget !== "utility" ||
            candidate.modelRef !== (result.utilityModel ?? result.setupModel)) &&
            (!result.configuredModel ||
              (candidate.kind !== "existing-model" &&
                candidate.modelRef !== result.configuredModel))),
      )
      .toSorted((a, b) => a.label.localeCompare(b.label));
  });
  return (
    <Show when={candidates().length > 0}>
      <section class="settings-section">
        <div class="settings-section__header">
          <h2>{t("modelSetup.candidates.title")}</h2>
        </div>
        <div class="model-setup__rows">
          <For each={candidates()}>
            {(candidate) => {
              const active = () =>
                (props.activation.phase === "testing" || props.activation.phase === "failure") &&
                props.activation.targetId ===
                  activationTargetId(candidate.kind, candidate.modelRef);
              const testing = () => active() && props.activation.phase === "testing";
              const failure = () => active() && props.activation.phase === "failure";
              return (
                <div class="model-setup__row" data-candidate-kind={candidate.kind}>
                  <div class="model-setup__row-main">
                    <div class="model-setup__row-title">
                      {renderProviderIcon(props, candidate)}
                      <strong>{candidate.label}</strong>
                      <span class="model-setup__chip">{candidateStatus(candidate)}</span>
                    </div>
                    <div class="muted">
                      {candidate.modelRef} · {formatUiExternalText(candidate.detail)}
                    </div>
                    {candidate.modelTarget === "utility" ? (
                      <div class="muted">{t("modelSetup.utility.hint")}</div>
                    ) : undefined}
                  </div>
                  <div class="model-setup__row-actions">
                    <button
                      type="button"
                      class={["btn", { primary: !failure() }]}
                      disabled={props.actionsDisabled || props.detecting}
                      onClick={() => props.onActivateCandidate(candidate)}
                    >
                      <span>
                        {t(
                          testing()
                            ? "modelSetup.candidates.testingButton"
                            : failure()
                              ? "modelSetup.candidates.retry"
                              : candidate.modelTarget === "utility"
                                ? props.result.configuredModel
                                  ? "modelSetup.utility.useUtility"
                                  : "modelSetup.utility.useSetup"
                                : props.embedded
                                  ? "modelSetup.discovery.useForAgent"
                                  : "modelSetup.candidates.testAndUse",
                        )}
                      </span>
                    </button>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </section>
    </Show>
  );
}
