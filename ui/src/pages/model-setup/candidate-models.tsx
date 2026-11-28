import { For, Show, createMemo } from "solid-js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderProviderIcon } from "./model-setup-icon-loader.tsx";
import { activationTargetId } from "./state.ts";
import type { ModelSetupViewProps } from "./view-types.ts";

registerModelSetupEnglish();

type Candidate = SystemAgentSetupDetectResult["candidates"][number];

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
  props: ModelSetupViewProps & { result: SystemAgentSetupDetectResult },
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
      <SettingsSection title={t("modelSetup.candidates.title")}>
        <For
          each={candidates()}
          keyed={(candidate) =>
            JSON.stringify([candidate.kind, candidate.modelRef, candidate.modelTarget])
          }
        >
          {(candidate) => {
            const active = () =>
              (props.activation.phase === "testing" || props.activation.phase === "failure") &&
              props.activation.targetId ===
                activationTargetId(candidate().kind, candidate().modelRef);
            const testing = () => active() && props.activation.phase === "testing";
            const failure = () => active() && props.activation.phase === "failure";
            return (
              <div
                class="settings-row model-setup__candidate"
                data-candidate-kind={candidate().kind}
              >
                {renderProviderIcon(props, candidate())}
                <div class="settings-row__text">
                  <span class="settings-row__title">
                    {candidate().label}{" "}
                    <span class="model-setup__chip">{candidateStatus(candidate())}</span>
                  </span>
                  <span class="settings-row__desc">
                    {candidate().modelRef} · {formatUiExternalText(candidate().detail)}
                  </span>
                  <Show when={candidate().modelTarget === "utility"}>
                    <span class="settings-row__desc">{t("modelSetup.utility.hint")}</span>
                  </Show>
                </div>
                <div class="settings-row__control">
                  {/* Detection is never consent: each model activates only from this click. */}
                  <button
                    type="button"
                    class={["btn btn--sm", { primary: !failure() }]}
                    disabled={props.actionsDisabled || props.detecting}
                    onClick={() => props.onActivateCandidate(candidate())}
                  >
                    {t(
                      testing()
                        ? "modelSetup.candidates.testingButton"
                        : failure()
                          ? "modelSetup.candidates.retry"
                          : candidate().modelTarget === "utility"
                            ? props.result.configuredModel
                              ? "modelSetup.utility.useUtility"
                              : "modelSetup.utility.useSetup"
                            : props.embedded
                              ? "modelSetup.discovery.useForAgent"
                              : "modelSetup.candidates.testAndUse",
                    )}
                  </button>
                </div>
              </div>
            );
          }}
        </For>
      </SettingsSection>
    </Show>
  );
}
