import { html, nothing, type TemplateResult } from "lit";
import { cache } from "lit/directives/cache.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { icons } from "../../components/icons.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import "../../styles/model-setup.css";
import type { ModelProviderLoginController } from "../model-providers/login-controller.ts";
import {
  renderMutationMessage,
  renderModelProviderConnectAction,
} from "../model-providers/view-status.ts";
import { renderCandidateRows } from "./candidate-models.ts";
import {
  renderActivationFeedback,
  renderConfiguredModel,
  renderConfiguredUtilityModel,
} from "./configured-model.ts";
import { renderModelSetupLoading } from "./loading-view.ts";
import { renderProviderIcon } from "./model-setup-icon-loader.ts";
import type { NativeModelSetup } from "./native-model-setup.ts";
import { listModelSetupPrepareOptions, type ModelSetupPrepareOption } from "./prepare-options.ts";
import { manualProviderName, renderManualProviderPicker } from "./provider-picker.ts";
import type {
  ModelSetupActivationState,
  ModelSetupPageState,
  ModelSetupVerifyState,
  ModelSetupWizardState,
} from "./state.ts";
import { renderModelSetupSuccessDialog } from "./success-dialog.ts";
import { renderModelSetupWizard } from "./wizard-view.ts";

registerModelSetupEnglish();

const MODEL_SETUP_DOCS_URL = "https://docs.openclaw.ai/concepts/model-providers";

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];
type ModelSetupViewProps = {
  connection?: ModelProviderLoginController["pageActions"];
  embedded?: boolean;
  agentLabel?: string;
  credentialChoices?: readonly string[];
  onClose?: () => void;
  onDiscoveryShown?: () => void;
  detecting?: boolean;
  detectionError?: string | null;
  page: ModelSetupPageState;
  activation: ModelSetupActivationState;
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
  actionsDisabled: boolean;
  manualProviderId: string;
  manualApiKey: string;
  manualError: string | null;
  moreSignInOpen: boolean;
  firstRun: boolean;
  nativeSessionCatalogsEnabled?: boolean;
  onNativeSessionCatalogsChange?: (enabled: boolean) => void;
  nativeModels?: NativeModelSetup;
  iconUrls: Readonly<Record<string, string>>;
  onDetect: () => void;
  onVerify: () => void;
  onActivateCandidate: (candidate: Candidate) => void;
  onStartAuth: (option: AuthOption) => void;
  onStartPrepare: (option: ModelSetupPrepareOption) => void;
  onManualProviderChange: (providerId: string) => void;
  onManualApiKeyChange: (apiKey: string) => void;
  onManualConnect: () => void;
  onMoreSignInToggle: (open: boolean) => void;
  onIconError: (iconUrl: string) => void;
  onOpenChat: () => void;
  onOpenSetupAssistant?: () => void;
  onSuccessClose: () => void;
  onWizardValueChange: (value: unknown) => void;
  onWizardAnswer: (value: unknown, includeValue?: boolean) => void;
  onWizardCancel: () => void;
  onWizardClose: () => void;
};

function renderEmptyState(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const installs = result.recommendedInstalls ?? [];
  if (
    props.nativeModels?.count ||
    result.candidates.length > 0 ||
    (result.authOptions?.length ?? 0) > 0 ||
    installs.length === 0
  ) {
    return nothing;
  }
  return html`
    <section class="settings-section model-setup__empty">
      <div class="settings-section__header">
        <h2>${t("modelSetup.empty.title")}</h2>
      </div>
      <p class="muted">${t("modelSetup.empty.intro")}</p>
      <div class="model-setup__recommendations">
        ${installs.map(
          (install) => html`
            <div class="model-setup__recommendation" data-recommended-install=${install.id}>
              ${renderProviderIcon(props, install, "model-setup__icon--recommendation")}
              <div class="model-setup__row-main">
                <strong>${install.label}</strong>
                <div class="muted">${install.hint}</div>
                <a href=${install.website} target="_blank" rel="noopener">${install.website}</a>
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderAuthRow(props: ModelSetupViewProps, option: AuthOption) {
  return html`
    <div class="model-setup__row" data-auth-choice=${option.id}>
      <div class="model-setup__provider-copy">
        ${renderProviderIcon(props, option)}
        <div>
          <strong>${option.label}</strong>
          ${option.groupLabel ? html`<div class="muted">${option.groupLabel}</div>` : nothing}
          ${option.hint ? html`<div class="muted">${option.hint}</div>` : nothing}
        </div>
      </div>
      <button
        type="button"
        class="btn"
        ?disabled=${props.actionsDisabled || props.detecting}
        @click=${() => props.onStartAuth(option)}
      >
        ${
          option.kind === "install"
            ? t("modelSetup.signIn.install")
            : option.kind === "custom"
              ? t("modelSetup.signIn.custom")
              : t("modelSetup.signIn.verify")
        }
      </button>
    </div>
  `;
}

function renderSignIn(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const options = (result.authOptions ?? [])
    .filter((option) => !props.embedded || !props.credentialChoices?.includes(option.id))
    .toSorted((a, b) => a.label.localeCompare(b.label));
  if (options.length === 0) {
    return nothing;
  }
  const featured = options.filter(
    (option) => option.featured || option.kind === "install" || option.kind === "custom",
  );
  const more = options.filter((option) => !featured.includes(option));
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.signIn.title")}</h2>
        <p>${t("modelSetup.signIn.description")}</p>
      </div>
      <div class="model-setup__rows">${featured.map((option) => renderAuthRow(props, option))}</div>
      ${
        more.length
          ? html`<details
              class="model-setup__more"
              .open=${props.moreSignInOpen}
              @toggle=${(event: Event) =>
                props.onMoreSignInToggle((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>${t("modelSetup.signIn.more")}</summary>
              <div class="model-setup__rows">
                ${more.map((option) => renderAuthRow(props, option))}
              </div>
            </details>`
          : nothing
      }
    </section>
  `;
}

function renderPrepare(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  if (!props.canPrepare) {
    return nothing;
  }
  const options = listModelSetupPrepareOptions(result);
  if (options.length === 0) {
    return nothing;
  }
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.prepare.title")}</h2>
      </div>
      <p class="muted">${t("modelSetup.prepare.intro")}</p>
      <div class="model-setup__rows">
        ${options.map(
          (option) => html`
            <div class="model-setup__row" data-prepare-choice=${option.id}>
              <div class="model-setup__provider-copy">
                ${renderProviderIcon(props, option)}
                <div>
                  <strong>${option.label}</strong>
                  ${option.hint ? html`<div class="muted">${option.hint}</div>` : nothing}
                </div>
              </div>
              <button
                type="button"
                class="btn"
                ?disabled=${props.actionsDisabled || props.detecting}
                @click=${() => props.onStartPrepare(option)}
              >
                ${option.actionLabel ?? t("modelSetup.prepare.ollamaButton")}
              </button>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function isManualConnectionChoice(
  props: ModelSetupViewProps,
  provider: SystemAgentSetupDetectResult["manualProviders"][number],
): boolean {
  return props.embedded === true && props.credentialChoices?.includes(provider.id) === true;
}

function renderManual(props: ModelSetupViewProps, detected: SystemAgentSetupDetectResult) {
  const result = props.embedded
    ? {
        ...detected,
        manualProviders: detected.manualProviders.filter(
          (provider) => !isManualConnectionChoice(props, provider),
        ),
      }
    : detected;
  if (result.manualProviders.length === 0 && props.embedded) {
    return nothing;
  }
  const provider = result.manualProviders.find((entry) => entry.id === props.manualProviderId);
  const targetId = `manual:${props.manualProviderId}`;
  const manualId = props.embedded ? "model-discovery-manual" : "model-setup-manual";
  const testing = props.activation.phase === "testing" && props.activation.targetId === targetId;
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.manual.title")}</h2>
      </div>
      <div class="model-setup__manual">
        <div class="field">
          <span>${t("modelSetup.manual.provider")}</span>
          ${renderManualProviderPicker(props, result, provider)}
        </div>
        <label class="field">
          <span>
            ${
              provider
                ? t("modelSetup.manual.accessValueFor", { provider: manualProviderName(provider) })
                : t("modelSetup.manual.accessValue")
            }
          </span>
          <input
            class="input"
            type="password"
            autocomplete="off"
            required
            aria-invalid=${props.manualError ? "true" : nothing}
            aria-describedby=${`${manualId}-help${props.manualError ? ` ${manualId}-error` : ""}`}
            .value=${props.manualApiKey}
            ?disabled=${props.actionsDisabled}
            placeholder=${t("modelSetup.manual.accessValuePlaceholder")}
            @input=${(event: Event) =>
              props.onManualApiKeyChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <div id=${`${manualId}-help`} class="model-setup__manual-help">
          ${icons.shieldCheck}
          <span>${t("modelSetup.manual.verifyHint")}</span>
        </div>
        ${
          props.manualError
            ? html`<div id=${`${manualId}-error`} class="callout danger" role="alert">
                ${props.manualError}
              </div>`
            : nothing
        }
        <button
          type="button"
          class="btn primary"
          ?disabled=${props.actionsDisabled || props.detecting || !props.manualProviderId}
          @click=${props.onManualConnect}
        >
          ${
            testing
              ? t("modelSetup.candidates.testingButton")
              : t(
                  props.embedded
                    ? "modelSetup.discovery.connectForAgent"
                    : "modelSetup.manual.connectAndVerify",
                )
          }
        </button>
      </div>
    </section>
  `;
}

export function revealModelSetupFeedback(root: ParentNode): void {
  // Reveal only this attempt synchronously; never move focus or leave work past route exit.
  root
    .querySelector(".model-setup > .model-setup__testing, .model-setup > .model-setup__failure")
    ?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
}

function renderNativeSessionDiscovery(
  props: ModelSetupViewProps,
  result: SystemAgentSetupDetectResult,
) {
  if (
    result.nativeSessionCatalogPreferenceRequired !== true ||
    !result.nativeSessionCatalogs?.length
  ) {
    return nothing;
  }
  return html`
    <section class="settings-section model-setup__native-discovery">
      <div class="settings-section__header"><h2>${t("modelSetup.nativeDiscovery.title")}</h2></div>
      <p class="muted">${t("modelSetup.nativeDiscovery.body")}</p>
      <p>${result.nativeSessionCatalogs.map((option) => option.label).join(", ")}</p>
      <label>
        <input
          type="checkbox"
          .checked=${props.nativeSessionCatalogsEnabled === true}
          ?disabled=${props.actionsDisabled}
          @change=${(event: Event) => {
            // SAFETY: This listener is attached directly to the checkbox input above.
            const input = event.currentTarget as HTMLInputElement;
            props.onNativeSessionCatalogsChange?.(input.checked);
          }}
        />
        ${t("modelSetup.nativeDiscovery.enable")}
      </label>
      <p class="muted">${t("modelSetup.nativeDiscovery.decline")}</p>
    </section>
  `;
}

function renderReady(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const onContinue =
    props.firstRun && result.setupComplete && props.activation.phase !== "success"
      ? props.onOpenChat
      : undefined;
  const primary =
    !props.embedded && result.configuredModel
      ? renderConfiguredModel({
          result,
          verify:
            props.verify.phase === "ok" && props.verify.modelTarget === "utility"
              ? { phase: "idle" }
              : props.verify,
          canVerify: props.canVerify,
          actionsDisabled: props.actionsDisabled || props.detecting === true,
          onVerify: props.onVerify,
          onContinue,
        })
      : nothing;
  const current = html`${primary}${renderConfiguredUtilityModel({
    result,
    activation: props.activation,
    canRepair: props.canAdmin && !props.gatewayTooOld,
    actionsDisabled:
      props.actionsDisabled || props.detecting === true || props.activationUnresolved === true,
    onOpenAssistant: props.onOpenSetupAssistant ?? props.onOpenChat,
    onActivateCandidate: props.onActivateCandidate,
  })}`;
  if (!props.canAdmin) {
    return html`${current}
      <div class="callout warning" role="note">${t("modelSetup.access.adminRequired")}</div>`;
  }
  if (props.gatewayTooOld) {
    return html`${current}
      <div class="callout warning" role="note">${t("modelSetup.access.gatewayTooOld")}</div>`;
  }
  return html`
    ${current} ${renderNativeSessionDiscovery(props, result)} ${renderEmptyState(props, result)}
    ${props.nativeModels?.render()} ${renderCandidateRows(props, result)}
    ${renderPrepare(props, result)} ${renderSignIn(props, result)} ${renderManual(props, result)}
  `;
}

export function renderModelSetup(props: ModelSetupViewProps): TemplateResult {
  let body: unknown;
  if (props.page.phase === "ready") {
    body = renderReady(
      { ...props, actionsDisabled: props.actionsDisabled || props.activationUnresolved === true },
      props.page.result,
    );
  } else if (!props.canAdmin) {
    body = html`<div class="callout warning" role="note">
      ${t("modelSetup.access.adminRequired")}
    </div>`;
  } else if (props.gatewayTooOld) {
    body = html`<div class="callout warning" role="note">
      ${t("modelSetup.access.gatewayTooOld")}
    </div>`;
  } else if (props.page.phase === "loading") {
    body = props.embedded
      ? html`<div class="model-setup__loading" role="status">${t("modelSetup.loading")}</div>`
      : renderModelSetupLoading(props.modelConfigured === true);
  } else if (props.page.phase === "detect-error") {
    body = html`
      <div class="callout danger" role="alert">${props.page.message}</div>
      <button type="button" class="btn" ?disabled=${props.detecting} @click=${props.onDetect}>
        ${t("modelSetup.retry")}
      </button>
    `;
  }
  const content = html`
    <div
      class="model-setup"
      aria-busy=${props.detecting || props.page.phase === "loading" ? "true" : "false"}
    >
      <div class="model-setup__intro">
        <div>
          ${
            props.embedded
              ? html`<h2>${t("modelSetup.discovery.title")}</h2>
                  <p>
                    ${t("modelSetup.discovery.description", { agent: props.agentLabel ?? "" })}
                  </p>`
              : html`<h1>${t("modelSetup.heading")}</h1>
                  <p>${t("modelSetup.intro")}</p>`
          }
        </div>
        ${props.connection ? renderModelProviderConnectAction(props.connection, true) : nothing}
        ${
          props.page.phase === "ready" &&
          (props.embedded || !props.page.result.configuredModel) &&
          props.activation.phase !== "success" &&
          props.canAdmin &&
          !props.gatewayTooOld
            ? html`<button
                type="button"
                class="btn"
                ?disabled=${props.actionsDisabled || props.detecting}
                @click=${props.onDetect}
              >
                ${props.detecting ? t("modelSetup.verify.checkingButton") : t("modelSetup.checkAgain")}
              </button>`
            : nothing
        }
      </div>
      ${
        props.canAdmin && !props.gatewayTooOld
          ? renderActivationFeedback(props.activation)
          : nothing
      }
      ${
        props.refreshWarning
          ? html`<div class="callout warning" role="alert">${props.refreshWarning}</div>`
          : nothing
      }
      ${
        props.activationUnresolved && !props.actionsDisabled && props.activation.phase !== "success"
          ? html`<div class="model-setup__recovery">
              <p>${t("modelSetup.recovery.unknown")}</p>
              ${
                props.page.phase === "ready" &&
                (props.page.result.configuredModel || props.page.result.setupModel) &&
                props.canVerify &&
                props.onUseCurrentModel
                  ? html`<button
                      type="button"
                      class="btn primary"
                      @click=${props.onUseCurrentModel}
                    >
                      ${t("modelSetup.recovery.useCurrent")}
                    </button>`
                  : nothing
              }
              <button type="button" class="btn" @click=${props.onDetect}>
                ${t("modelSetup.checkAgain")}
              </button>
            </div>`
          : nothing
      }
      ${renderMutationMessage(props.connection?.loginMessage)}
      ${props.detectionError ? html`<div class="callout warning" role="alert">${props.detectionError}</div>` : nothing}
      ${props.detecting && props.page.phase === "ready" ? html`<div class="muted" role="status">${t("modelSetup.loading")}</div>` : nothing}
      ${body}
    </div>
  `;
  const dialogs = html`
    ${props.connection?.login}
    <div @modal-cancel=${(event: Event) => event.preventDefault()}>
      ${renderModelSetupWizard({
        mode: props.wizardMode,
        state: props.wizard,
        refreshWarning: props.refreshWarning,
        cancellationNotice: props.cancellationNotice,
        value: props.wizardValue,
        onValueChange: props.onWizardValueChange,
        onAnswer: props.onWizardAnswer,
        onCancel: props.onWizardCancel,
        onClose: props.onWizardClose,
      })}
    </div>
    ${
      props.activation.phase === "success"
        ? renderModelSetupSuccessDialog(
            props.activation,
            props.activation.modelTarget === "utility"
              ? (props.onOpenSetupAssistant ?? props.onOpenChat)
              : props.onOpenChat,
            props.onSuccessClose,
            props.firstRun,
            props.embedded,
          )
        : nothing
    }
  `;
  if (props.embedded) {
    const wizardOpen = props.wizard.phase !== "idle" || props.activation.phase === "success";
    return html`
      ${cache(
        wizardOpen
          ? nothing
          : html`<openclaw-modal-dialog
              label=${t("modelSetup.discovery.title")}
              @modal-cancel=${() => props.onClose?.()}
              @wa-after-show=${(event: Event) =>
                event.target === event.currentTarget ? props.onDiscoveryShown?.() : undefined}
            >
              <div class="model-setup-wizard model-setup-discovery">
                <div class="model-setup-wizard__body">${content}</div>
                <div class="model-setup-wizard__footer">
                  <button class="btn" @click=${() => props.onClose?.()}>
                    ${t("common.close")}
                  </button>
                </div>
              </div>
            </openclaw-modal-dialog>`,
      )}
      ${dialogs}
    `;
  }
  return html`
    <section class="content-header">
      <div>
        <div class="page-title">${titleForRoute("model-setup")}</div>
        <div class="page-subtitle">
          ${subtitleForRoute("model-setup")} ${renderLearnMoreLink(MODEL_SETUP_DOCS_URL)}
        </div>
      </div>
    </section>
    ${renderSettingsWorkspace(content)} ${dialogs}
  `;
}
