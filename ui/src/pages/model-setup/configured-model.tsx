import type { JSX } from "@solidjs/web";
import { Show, createMemo } from "solid-js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import {
  providerDisplayLabel,
  providerIdFromModelRef,
} from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  activationTargetId,
  type ModelSetupActivationState,
  type ModelSetupVerifyState,
} from "./state.ts";

registerModelSetupEnglish();

type Candidate = SystemAgentSetupDetectResult["candidates"][number];

export function ConfiguredUtilityModel(props: {
  result: SystemAgentSetupDetectResult;
  activation: ModelSetupActivationState;
  canRepair: boolean;
  actionsDisabled: boolean;
  onOpenAssistant: () => void;
  onActivateCandidate: (candidate: Candidate) => void;
}) {
  const modelRef = createMemo(() => props.result.utilityModel ?? props.result.setupModel);
  const repairCandidate = createMemo(() =>
    props.canRepair
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
        <div class="settings-section__header">
          <h2>{t("modelSetup.utility.configured")}</h2>
        </div>
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
                  disabled={props.actionsDisabled}
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
              disabled={props.actionsDisabled}
              onClick={() => props.onOpenAssistant()}
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

function renderModelSetupFailure(status: string, error: string): JSX.Element {
  const key = FAILURE_KEYS[status] ?? "unknown";
  return (
    <div class="model-setup__failure" role="alert">
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

const VERIFICATION_BUTTON_LABELS = {
  checking: "modelSetup.verify.checkingButton",
  failed: "modelSetup.verify.retry",
  ok: "modelSetup.verify.checkAgain",
  idle: "modelSetup.verify.button",
};

export function ConfiguredModel(props: {
  result: SystemAgentSetupDetectResult;
  verify: ModelSetupVerifyState;
  canVerify: boolean;
  actionsDisabled: boolean;
  onVerify: () => void;
  onContinue?: () => void;
}): JSX.Element {
  const configuredRef = createMemo(() => props.result.configuredModel!);
  // A successful verify reports the model that actually answered; prefer it over
  // the detect-time snapshot so concurrent config changes cannot mislabel the result.
  const displayRef = createMemo(() =>
    props.verify.phase === "ok" ? props.verify.modelRef : configuredRef(),
  );
  const providerId = createMemo(() => providerIdFromModelRef(displayRef()));
  const configuredCandidate = createMemo(() =>
    displayRef() === configuredRef()
      ? props.result.candidates.find(
          (candidate) =>
            candidate.modelRef === configuredRef() && !candidate.kind.startsWith("saved-auth:"),
        )
      : undefined,
  );
  const providerLabel = () => {
    const id = providerId();
    return id ? providerDisplayLabel(id) : displayRef();
  };
  const description = createMemo(() => {
    const name = displayRef().slice(displayRef().indexOf("/") + 1);
    const detail = configuredCandidate()?.detail.trim();
    return !detail || configuredCandidate()?.kind === "existing-model"
      ? name
      : detail.toLowerCase().includes(name.toLowerCase())
        ? detail
        : `${name} · ${detail}`;
  });

  return (
    <section class="settings-section model-setup__current" data-verify-phase={props.verify.phase}>
      <div class="settings-section__header">
        <h2>{t("modelSetup.verify.title")}</h2>
      </div>
      <div class="model-setup__row">
        <div class="model-setup__provider-copy">
          <Show when={providerId()} keyed>
            {(id) => <ProviderBrandIcon provider={id} class="model-setup__icon" />}
          </Show>
          <div class="model-setup__current-copy">
            <strong>{providerLabel()}</strong>
            <div class="muted">{description()}</div>
            {props.verify.phase === "checking" ? (
              <div class="model-setup__testing" role="status">
                {t("modelSetup.verify.checking", { modelRef: configuredRef() })}
              </div>
            ) : props.verify.phase === "ok" ? (
              <div class="model-setup__verified" role="status">
                {props.verify.latencyMs === undefined
                  ? t("modelSetup.verify.ready")
                  : t("modelSetup.verify.readyIn", {
                      latencyMs: String(props.verify.latencyMs),
                    })}
              </div>
            ) : props.verify.phase === "failed" ? (
              renderModelSetupFailure(props.verify.status, props.verify.error)
            ) : undefined}
          </div>
        </div>
        <div class="model-setup__row-actions">
          {props.canVerify ? (
            <button
              type="button"
              class="btn"
              disabled={props.actionsDisabled}
              onClick={() => props.onVerify()}
            >
              {t(VERIFICATION_BUTTON_LABELS[props.verify.phase])}
            </button>
          ) : undefined}
          {props.onContinue ? (
            <button type="button" class="btn primary" onClick={() => props.onContinue?.()}>
              <Icon name="messageSquare" /> {t("modelSetup.success.continueSetup")}
            </button>
          ) : undefined}
        </div>
      </div>
    </section>
  );
}

export function renderActivationFeedback(activation: ModelSetupActivationState) {
  // Feedback follows the activation attempt, including prepared models absent from discovery.
  if (activation.phase === "testing") {
    return (
      <div class="model-setup__testing" role="status">
        {t("modelSetup.testing")}
      </div>
    );
  }
  return activation.phase === "failure"
    ? renderModelSetupFailure(activation.status, activation.error)
    : undefined;
}
