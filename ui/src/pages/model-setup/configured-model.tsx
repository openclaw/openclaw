import type { JSX } from "@solidjs/web";
import { Show, createMemo } from "solid-js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSectionHeader } from "../../components/solid/settings-ui.tsx";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { activationTargetId, type ModelSetupActivationState } from "./state.ts";
import type { ModelSetupViewProps } from "./view-types.ts";

registerModelSetupEnglish();

export function ConfiguredUtilityModel(
  props: ModelSetupViewProps & { result: SystemAgentSetupDetectResult },
) {
  const modelRef = createMemo(() => props.result.utilityModel ?? props.result.setupModel);
  const repairCandidate = createMemo(() =>
    props.canAdmin && !props.gatewayTooOld
      ? props.result.candidates.find(
          (candidate) =>
            candidate.modelTarget === "utility" &&
            candidate.modelRef === modelRef() &&
            candidate.kind.startsWith("provider-auto:"),
        )
      : undefined,
  );
  const repairing = () => {
    const candidate = repairCandidate();
    return (
      candidate &&
      props.activation.phase === "testing" &&
      props.activation.targetId === activationTargetId(candidate.kind, candidate.modelRef)
    );
  };
  return (
    <Show when={modelRef()}>
      <section class="settings-section model-setup__utility">
        <SettingsSectionHeader title={t("modelSetup.utility.configured")} />
        <div class="model-setup__row">
          <div class="model-setup__row-main">
            <strong>{modelRef()}</strong>
            <div class="muted">
              {t(
                props.result.configuredModel
                  ? "modelSetup.utility.primaryReady"
                  : "modelSetup.utility.choosePrimary",
              )}
            </div>
          </div>
          <div class="model-setup__row-actions">
            <Show when={repairCandidate()}>
              {(candidate) => (
                <button
                  type="button"
                  class="btn"
                  disabled={props.actionsDisabled || props.detecting === true}
                  onClick={() => props.onActivateCandidate(candidate())}
                >
                  {t(
                    repairing()
                      ? "modelSetup.candidates.testingButton"
                      : "modelSetup.utility.repair",
                  )}
                </button>
              )}
            </Show>
            <button
              type="button"
              class="btn primary"
              disabled={props.actionsDisabled || props.detecting === true}
              onClick={() => (props.onOpenSetupAssistant ?? props.onOpenChat)()}
            >
              {t("modelSetup.utility.openAssistant")}
            </button>
          </div>
        </div>
      </section>
    </Show>
  );
}

const FAILURE_KEYS: Record<string, string> = {
  auth: "auth",
  rate_limit: "rateLimit",
  billing: "billing",
  timeout: "timeout",
  format: "format",
  unavailable: "unavailable",
  unknown: "unknown",
};

export function renderModelSetupFailure(
  status: string,
  error: string,
  ref?: (element: HTMLDivElement) => void,
): JSX.Element {
  const key = FAILURE_KEYS[status] ?? "unknown";
  return (
    <div ref={ref} class="model-setup__failure" role="alert">
      <span class="model-setup__failure-icon" aria-hidden="true">
        <Icon name="alertTriangle" />
      </span>
      <span>
        <strong>{t(`modelSetup.failure.${key}`)}.</strong> {error}{" "}
        {key === "unavailable" ? undefined : t(`modelSetup.failureGuidance.${key}`)}
      </span>
    </div>
  );
}

export function renderActivationFeedback(
  activation: ModelSetupActivationState,
  ref?: (element: HTMLDivElement) => void,
) {
  // Feedback follows the activation attempt, including prepared models absent from discovery.
  if (activation.phase === "testing") {
    return (
      <div ref={ref} class="model-setup__testing" role="status">
        {t("modelSetup.testing")}
      </div>
    );
  }
  return activation.phase === "failure"
    ? renderModelSetupFailure(activation.status, activation.error, ref)
    : undefined;
}
