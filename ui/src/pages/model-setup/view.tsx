import { createMemo, For, Match, Show, Switch, untrack } from "solid-js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { JSX } from "../../types/solid-elements.js";
import "../../styles/model-setup.css";
import type { ModelProviderLoginController } from "../model-providers/login-controller.ts";
import {
  renderMutationMessage,
  ModelProviderConnectAction,
} from "../model-providers/view-status.tsx";
import { CandidateRows, type CandidateRowsProps } from "./candidate-models.tsx";
import {
  renderActivationFeedback,
  ConfiguredModel,
  ConfiguredUtilityModel,
} from "./configured-model.tsx";
import { renderModelSetupLoading } from "./loading-view.tsx";
import { renderProviderIcon } from "./model-setup-icon-loader.tsx";
import type { NativeModelSetup } from "./native-model-setup.tsx";
import { listModelSetupPrepareOptions, type ModelSetupPrepareOption } from "./prepare-options.ts";
import { manualProviderName, ManualProviderPicker } from "./provider-picker.tsx";
import type { ModelSetupPageState, ModelSetupVerifyState, ModelSetupWizardState } from "./state.ts";
import { ModelSetupSuccessDialog } from "./success-dialog.tsx";
import { ModelSetupWizard } from "./wizard-view-solid.tsx";

registerModelSetupEnglish();

const MODEL_SETUP_DOCS_URL = "https://docs.openclaw.ai/concepts/model-providers";

type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];
export type ModelSetupViewProps = CandidateRowsProps & {
  connection?: ModelProviderLoginController["pageActions"];
  login?: JSX.Element;
  revision?: () => unknown;
  agentLabel?: string;
  credentialChoices?: readonly string[];
  onClose?: () => void;
  onDiscoveryShown?: () => void;
  detectionError?: string | null;
  page: ModelSetupPageState;
  verify: ModelSetupVerifyState;
  wizard: ModelSetupWizardState;
  wizardMode: "auth" | "prepare" | "activate";
  wizardValue: unknown;
  canAdmin: boolean;
  canVerify: boolean;
  canPrepare: boolean;
  modelConfigured?: boolean;
  gatewayTooOld: boolean;
  refreshWarning: string | null;
  cancellationNotice?: string | null;
  activationUnresolved?: boolean;
  onUseCurrentModel?: () => void;
  manualProviderId: string;
  manualApiKey: string;
  manualError: string | null;
  moreSignInOpen: boolean;
  firstRun: boolean;
  nativeSessionCatalogsEnabled?: boolean;
  onNativeSessionCatalogsChange?: (enabled: boolean) => void;
  nativeModels?: NativeModelSetup;
  onDetect: () => void;
  onVerify: () => void;
  onStartAuth: (option: AuthOption) => void;
  onStartPrepare: (option: ModelSetupPrepareOption) => void;
  onManualProviderChange: (providerId: string) => void;
  onManualApiKeyChange: (apiKey: string) => void;
  onManualConnect: () => void;
  onMoreSignInToggle: (open: boolean) => void;
  onOpenChat: () => void;
  onOpenSetupAssistant?: () => void;
  onSuccessClose: () => void;
  onWizardValueChange: (value: unknown) => void;
  onWizardAnswer: (value: unknown, includeValue?: boolean) => void;
  onWizardCancel: () => void;
  onWizardClose: () => void;
};

function EmptyState(props: ModelSetupViewProps & { result: SystemAgentSetupDetectResult }) {
  const installs = createMemo(() => props.result.recommendedInstalls ?? []);
  const visible = () => {
    props.revision?.();
    return (
      !props.nativeModels?.count &&
      props.result.candidates.length === 0 &&
      (props.result.authOptions?.length ?? 0) === 0 &&
      installs().length > 0
    );
  };
  return (
    <Show when={visible()}>
      <section class="settings-section model-setup__empty">
        <div class="settings-section__header">
          <h2>{t("modelSetup.empty.title")}</h2>
        </div>
        <p class="muted">{t("modelSetup.empty.intro")}</p>
        <div class="model-setup__recommendations">
          <For each={installs()}>
            {(install) => (
              <div class="model-setup__recommendation" data-recommended-install={install.id}>
                {renderProviderIcon(props, install, "model-setup__icon--recommendation")}
                <div class="model-setup__row-main">
                  <strong>{install.label}</strong>
                  <div class="muted">{install.hint}</div>
                  <a href={install.website} target="_blank" rel="noopener">
                    {install.website}
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
  const actionLabel = () => {
    const option = props.option;
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
          <strong>{props.option.label}</strong>
          <Show when={groupLabel()}>
            <div class="muted">{groupLabel()}</div>
          </Show>
          <Show when={props.option.hint}>
            <div class="muted">{props.option.hint}</div>
          </Show>
        </div>
      </div>
      <button
        type="button"
        class="btn"
        disabled={props.view.actionsDisabled || props.view.detecting}
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
  const options = createMemo(() =>
    (props.result.authOptions ?? [])
      .filter((option) => !props.embedded || !props.credentialChoices?.includes(option.id))
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
        <div class="settings-section__header">
          <h2>{t("modelSetup.signIn.title")}</h2>
          <p>{t("modelSetup.signIn.description")}</p>
        </div>
        <div class="model-setup__rows">
          <For each={featured()}>{(option) => <SetupActionRow view={props} option={option} />}</For>
        </div>
        <Show when={more().length > 0}>
          <details
            class="model-setup__more"
            prop:open={props.moreSignInOpen}
            onToggle={(event) => props.onMoreSignInToggle(event.currentTarget.open)}
          >
            <summary>{t("modelSetup.signIn.more")}</summary>
            <div class="model-setup__rows">
              <For each={more()}>{(option) => <SetupActionRow view={props} option={option} />}</For>
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
        <div class="settings-section__header">
          <h2>{t("modelSetup.prepare.title")}</h2>
        </div>
        <p class="muted">{t("modelSetup.prepare.intro")}</p>
        <div class="model-setup__rows">
          <For each={options()}>{(option) => <SetupActionRow view={props} option={option} />}</For>
        </div>
      </section>
    </Show>
  );
}

function Manual(props: ModelSetupViewProps & { detected: SystemAgentSetupDetectResult }) {
  const manualProviders = createMemo(() =>
    props.embedded
      ? props.detected.manualProviders.filter(
          (provider) => !props.credentialChoices?.includes(provider.id),
        )
      : props.detected.manualProviders,
  );
  const provider = createMemo(() =>
    manualProviders().find((entry) => entry.id === props.manualProviderId),
  );
  const targetId = () => `manual:${props.manualProviderId}`;
  const manualId = () => (props.embedded ? "model-discovery-manual" : "model-setup-manual");
  const testing = () =>
    props.activation.phase === "testing" && props.activation.targetId === targetId();
  return (
    <Show when={manualProviders().length > 0 || !props.embedded}>
      <section class="settings-section">
        <div class="settings-section__header">
          <h2>{t("modelSetup.manual.title")}</h2>
        </div>
        <div class="model-setup__manual">
          <div class="field">
            <span>{t("modelSetup.manual.provider")}</span>
            <ManualProviderPicker
              {...props}
              result={{ manualProviders: manualProviders() }}
              provider={provider()}
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
              type="password"
              autocomplete="off"
              required
              aria-invalid={props.manualError ? "true" : undefined}
              aria-describedby={`${manualId()}-help${props.manualError ? ` ${manualId()}-error` : ""}`}
              value={props.manualApiKey}
              disabled={props.actionsDisabled}
              placeholder={t("modelSetup.manual.accessValuePlaceholder")}
              onInput={(event) => props.onManualApiKeyChange(event.currentTarget.value)}
            />
          </label>
          <div id={`${manualId()}-help`} class="model-setup__manual-help">
            <Icon name="shieldCheck" />
            <span>{t("modelSetup.manual.verifyHint")}</span>
          </div>
          {props.manualError ? (
            <div id={`${manualId()}-error`} class="callout danger" role="alert">
              {props.manualError}
            </div>
          ) : undefined}
          <button
            type="button"
            class="btn primary"
            disabled={props.actionsDisabled || props.detecting || !props.manualProviderId}
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

export function revealModelSetupFeedback(root: ParentNode): void {
  // Reveal only this attempt synchronously; never move focus or leave work past route exit.
  root
    .querySelector(".model-setup > .model-setup__testing, .model-setup > .model-setup__failure")
    ?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
}

function NativeSessionDiscovery(
  props: ModelSetupViewProps & { result: SystemAgentSetupDetectResult },
) {
  return (
    <Show
      when={
        props.result.nativeSessionCatalogPreferenceRequired === true &&
        props.result.nativeSessionCatalogs?.length
      }
    >
      <section class="settings-section model-setup__native-discovery">
        <div class="settings-section__header">
          <h2>{t("modelSetup.nativeDiscovery.title")}</h2>
        </div>
        <p class="muted">{t("modelSetup.nativeDiscovery.body")}</p>
        <p>{props.result.nativeSessionCatalogs?.map((option) => option.label).join(", ")}</p>
        <label>
          <input
            type="checkbox"
            checked={props.nativeSessionCatalogsEnabled === true}
            disabled={props.actionsDisabled}
            onChange={(event) => props.onNativeSessionCatalogsChange?.(event.currentTarget.checked)}
          />
          {t("modelSetup.nativeDiscovery.enable")}
        </label>
        <p class="muted">{t("modelSetup.nativeDiscovery.decline")}</p>
      </section>
    </Show>
  );
}

function renderSetupAccessWarning(canAdmin: boolean) {
  return (
    <div class="callout warning" role="note">
      {t(canAdmin ? "modelSetup.access.gatewayTooOld" : "modelSetup.access.adminRequired")}
    </div>
  );
}

function NativeModels(props: { owner: NativeModelSetup; revision?: () => unknown }) {
  return untrack(() => props.owner.render(props.revision));
}

function Ready(props: ModelSetupViewProps & { result: SystemAgentSetupDetectResult }) {
  const verify = createMemo(() =>
    props.verify.phase === "ok" && props.verify.modelTarget === "utility"
      ? { phase: "idle" as const }
      : props.verify,
  );
  return (
    <>
      <Show when={!props.embedded && props.result.configuredModel}>
        <ConfiguredModel
          result={props.result}
          verify={verify()}
          canVerify={props.canVerify}
          actionsDisabled={props.actionsDisabled || props.detecting === true}
          onVerify={() => props.onVerify()}
          onContinue={
            props.firstRun && props.result.setupComplete && props.activation.phase !== "success"
              ? props.onOpenChat
              : undefined
          }
        />
      </Show>
      <ConfiguredUtilityModel
        result={props.result}
        activation={props.activation}
        canRepair={props.canAdmin && !props.gatewayTooOld}
        actionsDisabled={props.actionsDisabled || props.detecting === true}
        onOpenAssistant={() => (props.onOpenSetupAssistant ?? props.onOpenChat)()}
        onActivateCandidate={(candidate) => props.onActivateCandidate(candidate)}
      />
      <Show
        when={props.canAdmin && !props.gatewayTooOld}
        fallback={renderSetupAccessWarning(props.canAdmin)}
      >
        <NativeSessionDiscovery {...props} />
        <EmptyState {...props} />
        <Show when={props.nativeModels}>
          {(owner) => <NativeModels owner={owner()} revision={props.revision} />}
        </Show>
        <CandidateRows {...props} />
        <Prepare {...props} />
        <SignIn {...props} />
        <Manual {...props} detected={props.result} />
      </Show>
    </>
  );
}

function ModelSetupBody(props: ModelSetupViewProps) {
  const ready = createMemo(() => (props.page.phase === "ready" ? props.page.result : undefined));
  const error = createMemo(() =>
    props.page.phase === "detect-error" ? props.page.message : undefined,
  );
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
      <Match when={props.page.phase === "loading"}>
        {props.embedded ? (
          <div class="model-setup__loading" role="status">
            {t("modelSetup.loading")}
          </div>
        ) : (
          renderModelSetupLoading(props.modelConfigured === true)
        )}
      </Match>
      <Match when={error()}>
        {(message) => (
          <>
            <div class="callout danger" role="alert">
              {message()}
            </div>
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
      </Match>
    </Switch>
  );
}

export function ModelSetupView(props: ModelSetupViewProps): JSX.Element {
  const content = (
    <div
      class="model-setup"
      aria-busy={props.detecting || props.page.phase === "loading" ? "true" : "false"}
    >
      <div class="model-setup__intro">
        <div>
          {props.embedded ? (
            <>
              {" "}
              <h2>{t("modelSetup.discovery.title")}</h2>
              <p>{t("modelSetup.discovery.description", { agent: props.agentLabel ?? "" })}</p>{" "}
            </>
          ) : (
            <>
              {" "}
              <h1>{t("modelSetup.heading")}</h1>
              <p>{t("modelSetup.intro")}</p>{" "}
            </>
          )}
        </div>
        <Show when={Boolean(props.connection)}>
          <ModelProviderConnectAction
            onConnect={() => {
              void props.connection?.onConnect();
            }}
            connectDisabled={props.connection?.connectDisabled ?? true}
            primary
          />
        </Show>
        <Show
          when={
            props.page.phase === "ready" &&
            (props.embedded || !props.page.result.configuredModel) &&
            props.activation.phase !== "success" &&
            props.canAdmin &&
            !props.gatewayTooOld
          }
        >
          <button
            type="button"
            class="btn"
            disabled={props.actionsDisabled || props.detecting}
            onClick={() => props.onDetect()}
          >
            {props.detecting ? t("modelSetup.verify.checkingButton") : t("modelSetup.checkAgain")}
          </button>
        </Show>
      </div>
      {props.canAdmin && !props.gatewayTooOld
        ? renderActivationFeedback(props.activation)
        : undefined}
      {props.refreshWarning ? (
        <div class="callout warning" role="alert">
          {props.refreshWarning}
        </div>
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
      {renderMutationMessage(props.connection?.loginMessage)}
      {props.detectionError ? (
        <div class="callout warning" role="alert">
          {props.detectionError}
        </div>
      ) : undefined}
      {props.detecting && props.page.phase === "ready" ? (
        <div class="muted" role="status">
          {t("modelSetup.loading")}
        </div>
      ) : undefined}
      <ModelSetupBody {...props} />
    </div>
  );
  const dialogs = (
    <>
      {props.login}
      <div onModal-cancel={(event: Event) => event.preventDefault()}>
        <ModelSetupWizard
          mode={props.wizardMode}
          state={props.wizard}
          refreshWarning={props.refreshWarning}
          cancellationNotice={props.cancellationNotice}
          value={props.wizardValue}
          onValueChange={props.onWizardValueChange}
          onAnswer={props.onWizardAnswer}
          onCancel={props.onWizardCancel}
          onClose={props.onWizardClose}
        />
      </div>
      <Show when={props.activation.phase === "success" ? props.activation : undefined}>
        {(activation) => (
          <ModelSetupSuccessDialog
            activation={activation()}
            onOpenChat={() =>
              (activation().modelTarget === "utility"
                ? (props.onOpenSetupAssistant ?? props.onOpenChat)
                : props.onOpenChat)()
            }
            onClose={() => props.onSuccessClose()}
            firstRun={props.firstRun}
            returnToModels={props.embedded}
          />
        )}
      </Show>
    </>
  );

  return (
    <>
      {props.embedded ? (
        <EmbeddedModelSetup view={props} content={content} dialogs={dialogs} />
      ) : (
        <>
          <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
            <section class="content-header">
              <div>
                <div class="page-title">{titleForRoute("model-setup")}</div>
                <div class="page-subtitle">
                  {subtitleForRoute("model-setup")} <LearnMoreLink url={MODEL_SETUP_DOCS_URL} />
                </div>
              </div>
            </section>
          </ShellLayoutBoundary>
          <SettingsWorkspace>{content}</SettingsWorkspace> {dialogs}
        </>
      )}
    </>
  );
}

function EmbeddedModelSetup(props: {
  view: ModelSetupViewProps;
  content: JSX.Element;
  dialogs: JSX.Element;
}) {
  const wizardOpen = () =>
    props.view.wizard.phase !== "idle" || props.view.activation.phase === "success";
  const discovery = (
    <>
      {" "}
      <openclaw-modal-dialog
        label={t("modelSetup.discovery.title")}
        onModal-cancel={() => props.view.onClose?.()}
        onWa-after-show={(event: Event) =>
          event.target === event.currentTarget ? props.view.onDiscoveryShown?.() : undefined
        }
      >
        <div class="model-setup-wizard model-setup-discovery">
          <div class="model-setup-wizard__body">{props.content}</div>
          <div class="model-setup-wizard__footer">
            <button class="btn" onClick={() => props.view.onClose?.()}>
              {t("common.close")}
            </button>
          </div>
        </div>
      </openclaw-modal-dialog>{" "}
    </>
  );
  return (
    <>
      {wizardOpen() ? undefined : discovery}
      {props.dialogs}
    </>
  );
}
