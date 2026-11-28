import { createDeferred } from "@solidjs/signals";
import { createMemo, Errored, For, isPending, Loading, Match, Show, Switch } from "solid-js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import {
  SettingsRow,
  SettingsSection,
  SettingsSectionHeader,
} from "../../components/solid/settings-ui.tsx";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import "../../styles/model-setup.css";
import { t } from "../../lib/reactive/i18n.ts";
import type { JSX } from "../../types/solid-elements.js";
import { CandidateRows } from "./candidate-models.tsx";
import {
  renderActivationFeedback,
  renderModelSetupFailure,
  ConfiguredUtilityModel,
} from "./configured-model.tsx";
import { renderProviderIcon } from "./model-setup-icon-loader.tsx";
import { formatModelSetupError } from "./model-setup-task-result.ts";
import { listModelSetupPrepareOptions, type ModelSetupPrepareOption } from "./prepare-options.ts";
import { manualProviderName, ManualProviderPicker } from "./provider-picker.tsx";
import { ModelSetupSuccessDialog } from "./success-dialog.tsx";
import type { ModelSetupViewProps } from "./view-types.ts";
import { ModelSetupWizard } from "./wizard-view-solid.tsx";

registerModelSetupEnglish();

type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];

function EmptyState(props: ModelSetupViewProps & { result: SystemAgentSetupDetectResult }) {
  const installs = () => props.result.recommendedInstalls ?? [];
  const visible = () => {
    props.revision?.();
    return (
      props.result.candidates.length === 0 &&
      (props.result.authOptions?.length ?? 0) === 0 &&
      installs().length > 0
    );
  };
  return (
    <Show when={visible()}>
      <section class="settings-section model-setup__empty">
        <SettingsSectionHeader
          title={t("modelSetup.empty.title")}
          description={t("modelSetup.empty.intro")}
        />
        <div class="model-setup__recommendations">
          <For each={installs()} keyed={(install) => install.id}>
            {(install) => (
              <div class="model-setup__recommendation" data-recommended-install={install().id}>
                {renderProviderIcon(props, install(), "model-setup__icon--recommendation")}
                <div class="model-setup__row-main">
                  <strong>{install().label}</strong>
                  <div class="muted">{install().hint}</div>
                  <a href={install().website} target="_blank" rel="noopener">
                    {install().website}
                  </a>
                </div>
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}

function SetupActionRow(props: {
  view: ModelSetupViewProps;
  option: AuthOption | ModelSetupPrepareOption;
}) {
  const groupLabel = () => ("kind" in props.option ? props.option.groupLabel : undefined);
  const useChoiceLabel = () => {
    const option = props.option;
    // Native overrides leave the existing web auth treatment intact.
    return (
      "kind" in option &&
      (option.kind === "oauth" || option.kind === "device-code") &&
      option.actionLabel === undefined
    );
  };
  // Sign-in methods come from manifests; local setup waits for discovery,
  // which may find the model it would prepare.
  const disabled = () =>
    props.view.actionsDisabled || (!("kind" in props.option) && props.view.detecting);
  const actionLabel = () => {
    const option = props.option;
    if (useChoiceLabel()) {
      return option.label;
    }
    return "kind" in option
      ? t(
          option.kind === "install"
            ? "modelSetup.signIn.install"
            : option.kind === "custom"
              ? "modelSetup.signIn.custom"
              : "modelSetup.signIn.verify",
        )
      : (option.actionLabel ?? t("modelSetup.prepare.ollamaButton"));
  };
  return (
    <div
      class="model-setup__row"
      data-auth-choice={"kind" in props.option ? props.option.id : undefined}
      data-prepare-choice={"kind" in props.option ? undefined : props.option.id}
    >
      <div class="model-setup__provider-copy">
        {renderProviderIcon(props.view, props.option)}
        <div>
          {useChoiceLabel() ? (
            <Show when={groupLabel() && groupLabel() !== props.option.label}>
              <strong>{groupLabel()}</strong>
            </Show>
          ) : (
            <>
              <strong>{props.option.label}</strong>
              <Show when={groupLabel()}>
                <div class="muted">{groupLabel()}</div>
              </Show>
            </>
          )}
          <Show when={props.option.hint}>
            <div class="muted">{props.option.hint}</div>
          </Show>
        </div>
      </div>
      <button
        type="button"
        class="btn"
        disabled={disabled()}
        onClick={() => {
          const option = props.option;
          if ("kind" in option) {
            props.view.onStartAuth(option);
          } else {
            props.view.onStartPrepare(option);
          }
        }}
      >
        {actionLabel()}
      </button>
    </div>
  );
}

function SignIn(props: ModelSetupViewProps & { result: SystemAgentSetupDetectResult }) {
  // The Models catalog already offers every provider sign-in; this lists only the rest.
  const options = createMemo(() =>
    (props.result.authOptions ?? [])
      .filter((option) => !props.credentialChoices?.includes(option.id))
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  );
  const featured = createMemo(() =>
    options().filter(
      (option) => option.featured || option.kind === "install" || option.kind === "custom",
    ),
  );
  const more = createMemo(() => options().filter((option) => !featured().includes(option)));
  return (
    <Show when={options().length > 0}>
      <section class="settings-section">
        <SettingsSectionHeader
          title={t("modelSetup.signIn.title")}
          description={t("modelSetup.signIn.description")}
        />
        <div class="model-setup__rows">
          <For each={featured()} keyed={(option) => option.id}>
            {(option) => <SetupActionRow view={props} option={option()} />}
          </For>
        </div>
        <Show when={more().length > 0}>
          <details
            class="model-setup__more"
            prop:open={props.moreSignInOpen}
            onToggle={(event) => props.onMoreSignInToggle(event.currentTarget.open)}
          >
            <summary>{t("modelSetup.signIn.more")}</summary>
            <div class="model-setup__rows">
              <For each={more()} keyed={(option) => option.id}>
                {(option) => <SetupActionRow view={props} option={option()} />}
              </For>
            </div>
          </details>
        </Show>
      </section>
    </Show>
  );
}

function Prepare(props: ModelSetupViewProps & { result: SystemAgentSetupDetectResult }) {
  const options = createMemo(() => listModelSetupPrepareOptions(props.result));
  return (
    <Show when={props.canPrepare && options().length > 0}>
      <section class="settings-section">
        <SettingsSectionHeader
          title={t("modelSetup.prepare.title")}
          description={t("modelSetup.prepare.intro")}
        />
        <div class="model-setup__rows">
          <For each={options()} keyed={(option) => option.id}>
            {(option) => <SetupActionRow view={props} option={option()} />}
          </For>
        </div>
      </section>
    </Show>
  );
}

function Manual(props: ModelSetupViewProps & { detected: SystemAgentSetupDetectResult }) {
  let input: HTMLInputElement | undefined;
  const manualProviders = createMemo(() =>
    props.detected.manualProviders.filter(
      (provider) => !props.credentialChoices?.includes(provider.id),
    ),
  );
  const provider = createMemo(() =>
    manualProviders().find((entry) => entry.id === props.manualProviderId),
  );
  const targetId = () => `manual:${props.manualProviderId}`;
  const testing = () =>
    props.activation.phase === "testing" && props.activation.targetId === targetId();
  return (
    <Show when={manualProviders().length > 0}>
      <section class="settings-section">
        <SettingsSectionHeader title={t("modelSetup.manual.title")} />
        <div class="model-setup__manual">
          <div class="field">
            <span>{t("modelSetup.manual.provider")}</span>
            <ManualProviderPicker
              {...props}
              result={{ manualProviders: manualProviders() }}
              provider={provider()}
              nextTabTarget={() => input}
            />
          </div>
          <label class="field">
            <span>
              {provider()
                ? t("modelSetup.manual.accessValueFor", {
                    provider: manualProviderName(provider()!),
                  })
                : t("modelSetup.manual.accessValue")}
            </span>
            <input
              class="input"
              ref={(element) => {
                input = element;
              }}
              type="password"
              autocomplete="off"
              required
              aria-invalid={props.manualError ? "true" : undefined}
              aria-describedby={`model-discovery-manual-help${props.manualError ? " model-discovery-manual-error" : ""}`}
              value={props.manualApiKey}
              disabled={props.actionsDisabled}
              placeholder={t("modelSetup.manual.accessValuePlaceholder")}
              onInput={(event) => props.onManualApiKeyChange(event.currentTarget.value)}
            />
          </label>
          <div id="model-discovery-manual-help" class="model-setup__manual-help">
            <Icon name="shieldCheck" />
            <span>{t("modelSetup.manual.verifyHint")}</span>
          </div>
          {props.manualError ? (
            <InlineAlert tone="danger" id="model-discovery-manual-error" role="alert">
              {props.manualError}
            </InlineAlert>
          ) : undefined}
          <button
            type="button"
            class="btn primary"
            disabled={props.actionsDisabled || !props.manualProviderId}
            onClick={() => props.onManualConnect()}
          >
            {t(
              testing()
                ? "modelSetup.candidates.testingButton"
                : props.embedded
                  ? "modelSetup.discovery.connectForAgent"
                  : "modelSetup.manual.connectAndVerify",
            )}
          </button>
        </div>
      </section>
    </Show>
  );
}

function renderSetupAccessWarning(canAdmin: boolean) {
  return (
    <InlineAlert tone="warning" role="note">
      {t(canAdmin ? "modelSetup.access.gatewayTooOld" : "modelSetup.access.adminRequired")}
    </InlineAlert>
  );
}

function Ready(props: ModelSetupViewProps & { result: SystemAgentSetupDetectResult }) {
  return (
    <>
      <ConfiguredUtilityModel {...props} />
      <Show
        when={props.canAdmin && !props.gatewayTooOld}
        fallback={renderSetupAccessWarning(props.canAdmin)}
      >
        <EmptyState {...props} />
        <CandidateRows {...props} />
        <Prepare {...props} />
        <SignIn {...props} />
        <Manual {...props} detected={props.result} />
      </Show>
    </>
  );
}

function SetupLoading() {
  return (
    <div class="model-setup__loading" role="status">
      {t("modelSetup.loading")}
    </div>
  );
}

function ModelSetupBody(props: ModelSetupViewProps & { detection: () => null }) {
  const ready = () => (props.page.phase === "ready" ? props.page.result : undefined);
  return (
    <Switch>
      <Match when={ready()}>
        {(result) => (
          <Ready
            {...props}
            result={result()}
            actionsDisabled={props.actionsDisabled || props.activationUnresolved === true}
          />
        )}
      </Match>
      <Match when={!props.canAdmin || props.gatewayTooOld}>
        {renderSetupAccessWarning(props.canAdmin)}
      </Match>
      <Match when={props.page.phase !== "ready"}>
        <Show keyed when={props.detectionIdentity()} fallback={<SetupLoading />}>
          <Errored
            fallback={(error) => (
              <>
                <InlineAlert tone="danger" role="alert">
                  {formatModelSetupError(error())}
                </InlineAlert>
                <button
                  type="button"
                  class="btn"
                  disabled={props.detecting}
                  onClick={() => props.onDetect()}
                >
                  {t("modelSetup.retry")}
                </button>
              </>
            )}
          >
            <Loading on={props.detectionIdentity()} fallback={<SetupLoading />}>
              <Show when={!isPending(props.detection)} fallback={<SetupLoading />}>
                {props.detection()}
                <SetupLoading />
              </Show>
            </Loading>
          </Errored>
        </Show>
      </Match>
    </Switch>
  );
}

function DetectionProgress(props: { page: ModelSetupViewProps["page"] }) {
  // Known choices stay usable while discovery finishes.
  return (
    <Show when={props.page.phase === "ready"}>
      <div class="muted" role="status">
        {t("modelSetup.loading")}
      </div>
    </Show>
  );
}

/** Activation progress, failures and unresolved-activation recovery. */
function ActivationNotices(props: ModelSetupViewProps) {
  return (
    <>
      {props.canAdmin && !props.gatewayTooOld
        ? renderActivationFeedback(props.activation, props.onFeedback)
        : undefined}
      {props.verify.phase === "checking" ? (
        <div class="model-setup__testing" role="status">
          {t("modelSetup.testing")}
        </div>
      ) : props.verify.phase === "failed" ? (
        renderModelSetupFailure(props.verify.status, props.verify.error)
      ) : undefined}
      {props.refreshWarning ? (
        <InlineAlert tone="warning" role="alert">
          {props.refreshWarning}
        </InlineAlert>
      ) : undefined}
      <Show
        when={Boolean(
          props.activationUnresolved &&
          !props.actionsDisabled &&
          props.activation.phase !== "success",
        )}
      >
        <div class="model-setup__recovery">
          <p>{t("modelSetup.recovery.unknown")}</p>
          <Show
            when={
              props.page.phase === "ready" &&
              Boolean(props.page.result.configuredModel || props.page.result.setupModel) &&
              props.canVerify &&
              props.onUseCurrentModel !== undefined
            }
          >
            <button type="button" class="btn primary" onClick={() => props.onUseCurrentModel?.()}>
              {t("modelSetup.recovery.useCurrent")}
            </button>
          </Show>
          <button type="button" class="btn" onClick={() => props.onDetect()}>
            {t("modelSetup.checkAgain")}
          </button>
        </div>
      </Show>
    </>
  );
}

/** First-run additions above the Models catalog; nothing renders until there is something to act on. */
function FirstRunSummary(props: ModelSetupViewProps) {
  const result = () => (props.page.phase === "ready" ? props.page.result : undefined);
  // A configured model is verified on request; once it answers, first run hands off to onboarding.
  // Verification names the model that actually answered, which can differ from the scan.
  const configuredModel = () =>
    props.activation.phase !== "success" && result()?.configuredModel
      ? props.verify.phase === "ok"
        ? props.verify.modelRef
        : result()?.configuredModel
      : undefined;
  return (
    <>
      {/* The open discovery dialog shows these notices beside the action that caused them. */}
      <Show when={!props.discoveryOpen}>
        <ActivationNotices {...props} />
      </Show>
      <Show when={configuredModel()}>
        {(model) => (
          <SettingsSection title={t("modelSetup.success.configuredModel")}>
            <SettingsRow
              title={model()}
              control={
                result()?.setupComplete ? (
                  <button
                    type="button"
                    class="btn btn--sm primary"
                    onClick={() => props.onOpenChat()}
                  >
                    {t("modelSetup.success.continueSetup")}
                  </button>
                ) : props.canVerify ? (
                  <button
                    type="button"
                    class="btn btn--sm"
                    disabled={props.actionsDisabled || props.detecting === true}
                    onClick={() => props.onVerify()}
                  >
                    {t(
                      props.verify.phase === "failed"
                        ? "modelSetup.verify.retry"
                        : "modelSetup.verify.button",
                    )}
                  </button>
                ) : undefined
              }
            />
          </SettingsSection>
        )}
      </Show>
      <Show when={props.canAdmin && !props.gatewayTooOld ? result() : undefined}>
        {(ready) => (
          <CandidateRows
            {...props}
            result={ready()}
            actionsDisabled={props.actionsDisabled || props.activationUnresolved === true}
          />
        )}
      </Show>
    </>
  );
}

export function ModelSetupView(props: ModelSetupViewProps): JSX.Element {
  const checkAgainVisible = () =>
    props.page.phase === "ready" &&
    props.activation.phase !== "success" &&
    props.canAdmin &&
    !props.gatewayTooOld;
  const checkAgainLabel = () =>
    t(props.detecting ? "modelSetup.verify.checkingButton" : "modelSetup.checkAgain");
  // Retain accepted forms without holding synchronous owner and busy publications.
  const detection: () => null = createDeferred(
    () =>
      props.detectionIdentity()?.completion.then((outcome) => {
        if (outcome && "error" in outcome) {
          throw outcome.error;
        }
        return null;
      }) ?? null,
  );
  const content = (
    <div
      class="model-setup"
      aria-busy={props.detecting || props.page.phase === "loading" ? "true" : "false"}
    >
      <div class="model-setup__intro">
        <button
          type="button"
          class="btn"
          aria-label={checkAgainLabel()}
          aria-hidden={checkAgainVisible() ? undefined : "true"}
          style={{
            display: "inline-grid",
            "grid-template-areas": '"label"',
            visibility: checkAgainVisible() ? undefined : "hidden",
          }}
          disabled={!checkAgainVisible() || props.actionsDisabled || props.detecting}
          onClick={() => props.onDetect()}
        >
          {/* Both translations reserve the action's footprint without entering its name. */}
          <span aria-hidden="true" style={{ "grid-area": "label", visibility: "hidden" }}>
            {t("modelSetup.checkAgain")}
          </span>
          <span aria-hidden="true" style={{ "grid-area": "label", visibility: "hidden" }}>
            {t("modelSetup.verify.checkingButton")}
          </span>
          <span style={{ "grid-area": "label" }}>{checkAgainLabel()}</span>
        </button>
      </div>
      <ActivationNotices {...props} />
      <Show when={props.page.phase === "ready"}>
        <Show keyed when={props.detectionIdentity()}>
          <Errored
            fallback={(error) => (
              <InlineAlert tone="warning" role="alert">
                {formatModelSetupError(error())}
              </InlineAlert>
            )}
          >
            <Loading
              on={props.detectionIdentity()}
              fallback={<DetectionProgress page={props.page} />}
            >
              <Show when={isPending(detection)} fallback={detection()}>
                <DetectionProgress page={props.page} />
              </Show>
            </Loading>
          </Errored>
        </Show>
      </Show>
      <ModelSetupBody {...props} detection={detection} />
    </div>
  );
  const wizardOpen = () => props.wizard.phase !== "idle" || props.activation.phase === "success";
  return (
    <>
      <Show when={props.firstRun}>
        <FirstRunSummary {...props} />
      </Show>
      <Show when={props.discoveryOpen && !wizardOpen()}>
        <openclaw-modal-dialog
          ref={(element) => props.onWizardDialog?.(element)}
          label={t("modelSetup.discovery.title")}
          onModal-cancel={() => props.onClose?.()}
          onOverlay-after-show={(event: Event) =>
            event.target === event.currentTarget ? props.onDiscoveryShown?.() : undefined
          }
        >
          <div class="oc-dialog model-setup-wizard model-setup-discovery">
            <div class="oc-dialog__header">
              <h2 class="oc-dialog__title">{t("modelSetup.discovery.title")}</h2>
              <IconButton
                size={28}
                class="oc-dialog__close"
                icon="x"
                label={t("common.close")}
                tooltip={false}
                onClick={() => props.onClose?.()}
              />
              <div class="oc-dialog__description">
                <p>{t("modelSetup.discovery.description", { agent: props.agentLabel ?? "" })}</p>
              </div>
            </div>
            <div class="oc-dialog__body model-setup-wizard__body">{content}</div>
          </div>
        </openclaw-modal-dialog>
      </Show>
      <div class="model-setup__dialogs" onModal-cancel={(event: Event) => event.preventDefault()}>
        <ModelSetupWizard
          onDialogRef={props.onWizardDialog}
          mode={props.wizardMode}
          state={props.wizard}
          busy={props.wizardBusy}
          refreshWarning={props.refreshWarning}
          cancellationNotice={props.cancellationNotice}
          value={props.wizardValue}
          onValueChange={props.onWizardValueChange}
          onAnswer={props.onWizardAnswer}
          onCancel={props.onWizardCancel}
          onClose={props.onWizardClose}
        />
      </div>
      <Show when={props.activation.phase === "success" ? props.activation : undefined} keyed>
        {(activation) => <ModelSetupSuccessDialog {...props} activation={activation} />}
      </Show>
    </>
  );
}
