import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { nativeSetupCapability } from "../../app/native-setup.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { isLoopbackHostname } from "../../lib/gateway-locality.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { ModelProviderIcon } from "../../lib/reactive/provider-presentation.tsx";
import type { CustodianSetupActions } from "./custodian-actions.ts";
import type {
  CustodianAutoSetup,
  SetupAuthOption,
  SetupCandidate,
  SetupFailure,
  SetupManualProvider,
  SetupStep,
} from "./custodian-auto-setup.ts";
import type { CustodianSessionStore } from "./custodian-session-store.ts";

const STEPS: SetupStep[] = ["welcome", "where", "ai"];

/** The Gateway's own error text, folded away as on the Mac. */
function ErrorDetails(props: { text: string }) {
  return (
    <details class="custodian-setup__stack">
      <summary>{t("custodian.autoSetup.showDetails")}</summary>
      <pre>{props.text}</pre>
      <button
        class="btn btn--ghost btn--sm"
        type="button"
        onClick={() => void copyToClipboard(props.text)}
      >
        {t("custodian.autoSetup.copyError")}
      </button>
    </details>
  );
}

/** Mirrors the macOS onboarding error card: one sentence, details folded away. */
function SetupError(props: { failure: SetupFailure; retry?: () => void; disabled?: boolean }) {
  return (
    <div class="callout warn custodian-setup__row" role="alert">
      <Icon name="alertTriangle" />
      <div class="custodian-setup__stack">
        <strong>{props.failure.title}</strong>
        <Show when={props.failure.summary}>{(summary) => <p>{summary()}</p>}</Show>
        <Show when={props.failure.detail}>{(detail) => <ErrorDetails text={detail()} />}</Show>
        <div class="custodian-setup__row">
          <Show when={props.retry}>
            {(retry) => (
              <button
                class="btn btn--sm primary"
                type="button"
                disabled={props.disabled}
                onClick={() => retry()()}
              >
                {t("common.retry")}
              </button>
            )}
          </Show>
          <a
            class="btn btn--ghost btn--sm"
            href="https://docs.openclaw.ai/start/onboarding"
            target="_blank"
            rel="noreferrer"
          >
            {t("custodian.autoSetup.openHelp")}
          </a>
        </div>
      </div>
    </div>
  );
}

function ChoiceRow(props: {
  icon: JSX.Element;
  title: string;
  detail?: string;
  trailing: JSX.Element;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      class={["option-card__choice", { "option-card__choice--selected": props.selected }]}
      type="button"
      disabled={props.disabled}
      aria-pressed={props.selected ? "true" : "false"}
      onClick={() => props.onClick?.()}
    >
      {props.icon}
      <span class="option-card__choice-copy">
        <strong>{props.title}</strong>
        <Show when={props.detail}>
          {(detail) => <span class="option-card__description">{detail()}</span>}
        </Show>
      </span>
      {props.trailing}
    </button>
  );
}

function WizardSteps(props: {
  setup: () => CustodianAutoSetup;
  actions: CustodianSetupActions;
  /** Choices whose own row shows their progress and failure. */
  rowKeys: () => string[];
}) {
  const state = () => props.setup().wizard.state;
  const step = () => {
    const current = state();
    return current.phase === "step" ? current : undefined;
  };
  const progress = () =>
    state().phase === "starting" ? props.setup().attempt?.progress : undefined;
  const failure = () => {
    const current = props.setup().attemptFailure;
    return current && !props.rowKeys().includes(current.key) ? current : null;
  };
  return (
    <>
      <Show when={progress()}>
        {(text) => (
          <p class="custodian-setup__row" role="status">
            <span class="btn__spinner" aria-hidden="true" />
            {text()}
          </p>
        )}
      </Show>
      <Show when={failure()}>{(current) => <SetupError failure={current()} />}</Show>
      <Show when={step()}>
        {(current) => (
          <div class="custodian-setup__stack">
            <Show when={current().step.title}>
              {(title) => <h3>{formatUiExternalText(title())}</h3>}
            </Show>
            <Show when={current().validationError}>
              {(message) => (
                <p id="custodian-setup-validation" style={{ color: "var(--danger)" }} role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <WizardStepControls
              step={current().step}
              value={props.setup().wizardValue}
              busy={props.actions.answering || current().busy}
              externalAuthInput={current().externalAuthInput}
              inputId="custodian-setup-sign-in"
              validationErrorId={
                current().validationError ? "custodian-setup-validation" : undefined
              }
              sensitiveRevealed={props.setup().wizardSecretVisible}
              onValueChange={(value) => props.setup().setWizardValue(value)}
              onAnswer={(value) => props.actions.answer(value)}
              onToggleSensitiveVisibility={() => props.setup().toggleWizardSecretVisibility()}
            />
            <button
              class="btn btn--ghost"
              type="button"
              disabled={props.actions.cancelling}
              onClick={() => props.actions.cancel()}
            >
              {t("custodian.cancel")}
            </button>
          </div>
        )}
      </Show>
    </>
  );
}

function signInActionLabel(option: SetupAuthOption): string {
  switch (option.kind) {
    case "device-code":
      return t("custodian.autoSetup.pairAction");
    case "install":
      return t("custodian.autoSetup.installAction");
    case "custom":
      return t("custodian.autoSetup.customAction");
    default:
      return t("custodian.autoSetup.signInAction");
  }
}

/** The Mac's inline "Connect with an API key or token" form, with the Model Setup copy. */
function ApiKeyForm(props: {
  providers: SetupManualProvider[];
  busy: boolean;
  onConnect: (provider: SetupManualProvider, key: string) => void;
}) {
  return (
    <form
      class="custodian-setup__stack"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const provider = props.providers.find((entry) => entry.id === data.get("provider"));
        const value = data.get("key");
        const key = typeof value === "string" ? value.trim() : "";
        if (provider && key) {
          props.onConnect(provider, key);
          form.reset();
        }
      }}
    >
      <label class="field">
        <span>{t("modelSetup.manual.provider")}</span>
        <select name="provider" disabled={props.busy}>
          <For each={props.providers}>
            {(provider) => (
              <option value={provider.id}>
                {provider.groupLabel ? `${provider.groupLabel}: ${provider.label}` : provider.label}
              </option>
            )}
          </For>
        </select>
      </label>
      <label class="field">
        <span>{t("modelSetup.manual.accessValue")}</span>
        <input
          name="key"
          type="password"
          autocomplete="off"
          required
          disabled={props.busy}
          placeholder={t("modelSetup.manual.accessValuePlaceholder")}
        />
      </label>
      <p class="muted">{t("modelSetup.manual.verifyHint")}</p>
      <button
        class="btn primary"
        style={{ "justify-self": "start" }}
        type="submit"
        disabled={props.busy}
      >
        {t("modelSetup.manual.connectAndVerify")}
      </button>
    </form>
  );
}

function ConnectAi(props: {
  setup: () => CustodianAutoSetup;
  actions: CustodianSetupActions;
  busy: () => boolean;
}) {
  const [apiKeysOpen, setApiKeysOpen] = createSignal(false);
  const detection = () => props.setup().detection;
  // A Codex login and the OpenAI sign-ins are all a ChatGPT account to the user: show one
  // ChatGPT choice. It uses a Codex login the Gateway already has, otherwise it signs in
  // with the Gateway's first ChatGPT sign-in. Codex installed without a saved login counts
  // as no login. Model Setup still lists every sign-in method.
  const chatgptLogin = () =>
    detection()?.candidates.find(
      (candidate) => candidate.kind === "codex-cli" && candidate.credentials === true,
    );
  const isChatgptSignIn = (option: SetupAuthOption) =>
    option.brandId === "openai" && (option.kind === "oauth" || option.kind === "device-code");
  const chatgptSignIn = (): SetupAuthOption | undefined => {
    const option = detection()?.authOptions?.find(isChatgptSignIn);
    if (!option) {
      return undefined;
    }
    // The method's own name and hint ("Codex login", Responses API notes) mean nothing here.
    const { hint: _hint, ...rest } = option;
    return { ...rest, label: t("custodian.autoSetup.chatgpt") };
  };
  // Utility-only choices (a setup helper model, not the assistant's model) cannot finish
  // first-run setup on their own, so the card leaves them to Model Setup.
  const primary = <T extends { modelTarget?: "utility" }>(entries: T[] | undefined) =>
    (entries ?? []).filter((entry) => entry.modelTarget !== "utility");
  const candidates = () =>
    primary(detection()?.candidates).filter((candidate) => candidate.kind !== "codex-cli");
  const authOptions = () =>
    primary(detection()?.authOptions).filter((option) => !isChatgptSignIn(option));
  const featured = () => authOptions().filter((option) => option.featured);
  const more = () => authOptions().filter((option) => !option.featured);
  const prepareOptions = () => primary(detection()?.prepareOptions);
  const manualProviders = () => primary(detection()?.manualProviders);
  const catalogs = () =>
    detection()?.nativeSessionCatalogPreferenceRequired
      ? (detection()?.nativeSessionCatalogs ?? [])
      : [];
  const rowKeys = () => [
    ...candidates().map((candidate) => candidate.kind),
    ...(chatgptLogin() ? ["codex-cli"] : []),
  ];
  const candidateRow = (
    candidate: Pick<
      SetupCandidate,
      "kind" | "label" | "modelRef" | "modelTarget" | "brandId" | "detail"
    >,
    chatgpt = false,
  ) => {
    const failure = () => {
      const current = props.setup().attemptFailure;
      return current?.key === candidate.kind ? current : null;
    };
    const testing = () => props.setup().testing === candidate.kind;
    // After a failed test of the existing login, the same row offers a fresh sign-in.
    const retry = () => (chatgpt && failure() ? chatgptSignIn() : undefined);
    return (
      <div>
        <ChoiceRow
          icon={<ModelProviderIcon provider={candidate.brandId ?? candidate.kind} />}
          title={chatgpt ? t("custodian.autoSetup.chatgpt") : candidate.label}
          detail={
            testing()
              ? t("custodian.autoSetup.testing")
              : (failure()?.summary ??
                (chatgpt ? t("custodian.autoSetup.chatgptExisting") : candidate.detail))
          }
          selected={testing()}
          disabled={props.busy()}
          trailing={
            testing() ? (
              <span class="btn__spinner" aria-hidden="true" />
            ) : retry() ? (
              <span class="option-card__description">{t("custodian.autoSetup.signInAction")}</span>
            ) : failure() ? (
              <Icon name="alertTriangle" />
            ) : (
              <span />
            )
          }
          onClick={() => {
            const option = retry();
            if (option) {
              props.actions.signIn(option);
            } else {
              props.actions.activate(candidate);
            }
          }}
        />
        <Show when={failure()?.detail}>{(detail) => <ErrorDetails text={detail()} />}</Show>
      </div>
    );
  };
  const authRow = (option: SetupAuthOption) => (
    <ChoiceRow
      icon={<ModelProviderIcon provider={option.brandId ?? option.id} />}
      title={option.label}
      detail={option.hint}
      disabled={props.busy()}
      trailing={<span class="option-card__description">{signInActionLabel(option)}</span>}
      onClick={() => props.actions.signIn(option)}
    />
  );
  return (
    <>
      <Show when={props.setup().error}>
        {(failure) => (
          <SetupError
            failure={failure()}
            retry={() => props.actions.retry()}
            disabled={props.busy()}
          />
        )}
      </Show>
      <Show when={!detection() && props.setup().pending}>
        <div class="custodian-setup__row" role="status">
          <span class="btn__spinner" aria-hidden="true" />
          <div class="option-card__choice-copy">
            <strong>{t("custodian.autoSetup.detecting")}</strong>
            <span class="option-card__description">{t("custodian.autoSetup.detectingDetail")}</span>
          </div>
        </div>
      </Show>
      <Show when={detection()}>
        {(current) => (
          <>
            <Show
              when={candidates().length || chatgptLogin()}
              fallback={
                <div class="custodian-setup__stack">
                  <strong>{t("custodian.autoSetup.noneFound")}</strong>
                  <span>
                    {t(
                      current().recommendedInstalls?.length
                        ? "custodian.autoSetup.noneFoundInstall"
                        : "custodian.autoSetup.noneFoundBody",
                    )}
                  </span>
                  <For each={current().recommendedInstalls ?? []}>
                    {(install) => (
                      <a
                        class="option-card__choice"
                        href={install.website}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ModelProviderIcon provider={install.brandId ?? install.id} />
                        <span class="option-card__choice-copy">
                          <strong>{install.label}</strong>
                          <span class="option-card__description">{install.hint}</span>
                        </span>
                        <Icon name="arrowUpRight" />
                      </a>
                    )}
                  </For>
                  <button
                    class="btn btn--sm"
                    style={{ "justify-self": "start" }}
                    type="button"
                    disabled={props.busy()}
                    onClick={() => props.actions.retry()}
                  >
                    {t("custodian.autoSetup.checkAgain")}
                  </button>
                </div>
              }
            >
              <div class="custodian-setup__stack">
                <Show when={chatgptLogin()}>{(login) => candidateRow(login(), true)}</Show>
                <For each={candidates()}>{(candidate) => candidateRow(candidate)}</For>
              </div>
            </Show>
            <Show when={current().unavailableCandidates?.length}>
              <div class="custodian-setup__stack">
                <strong>{t("custodian.autoSetup.unavailable")}</strong>
                <For each={current().unavailableCandidates ?? []}>
                  {(candidate) => (
                    <div class="custodian-setup__row">
                      <Icon name="info" />
                      <span class="option-card__choice-copy">
                        <strong>{candidate.label}</strong>
                        <span class="option-card__description">{candidate.reason}</span>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={prepareOptions().length}>
              <section class="callout custodian-setup__stack">
                <h3>{t("modelSetup.prepare.title")}</h3>
                <p class="muted">{t("modelSetup.prepare.intro")}</p>
                <For each={prepareOptions()}>
                  {(option) => (
                    <ChoiceRow
                      icon={<ModelProviderIcon provider={option.brandId ?? option.id} />}
                      title={option.label}
                      detail={option.hint}
                      disabled={props.busy()}
                      trailing={
                        <span class="option-card__description">
                          {option.actionLabel ?? t("custodian.autoSetup.installAction")}
                        </span>
                      }
                      onClick={() => props.actions.prepare(option)}
                    />
                  )}
                </For>
              </section>
            </Show>
            <section class="callout custodian-setup__stack">
              <Show when={catalogs().length}>
                <label class="custodian-setup__row">
                  <input
                    type="checkbox"
                    checked={props.setup().nativeSessionCatalogsEnabled}
                    disabled={props.busy()}
                    onChange={(event) =>
                      props.setup().setNativeSessionCatalogs(event.currentTarget.checked)
                    }
                  />
                  <span class="option-card__choice-copy">
                    <strong>{t("modelSetup.nativeDiscovery.enable")}</strong>
                    <span class="option-card__description">
                      {catalogs()
                        .map((catalog) => catalog.label)
                        .join(", ")}
                    </span>
                  </span>
                </label>
              </Show>
              <h3>{t("custodian.autoSetup.providersTitle")}</h3>
              <p class="muted">{t("custodian.autoSetup.providersBody")}</p>
              <Show when={!chatgptLogin() && chatgptSignIn()}>{(option) => authRow(option())}</Show>
              <For each={featured()}>{(option) => authRow(option)}</For>
              <Show when={manualProviders().length}>
                <ChoiceRow
                  icon={<Icon name="key" />}
                  title={t("custodian.autoSetup.apiKeys")}
                  detail={t("custodian.autoSetup.apiKeysHint")}
                  selected={apiKeysOpen()}
                  disabled={props.busy()}
                  trailing={
                    <span class="option-card__description">{t("custodian.autoSetup.connect")}</span>
                  }
                  onClick={() => setApiKeysOpen(true)}
                />
              </Show>
              <Show when={apiKeysOpen()}>
                <ApiKeyForm
                  providers={manualProviders()}
                  busy={props.busy()}
                  onConnect={(provider, key) => props.actions.connectKey(provider, key)}
                />
              </Show>
              <Show when={more().length}>
                <details class="custodian-setup__stack">
                  <summary>{t("custodian.autoSetup.moreSignIn")}</summary>
                  <For each={more()}>{(option) => authRow(option)}</For>
                </details>
              </Show>
            </section>
          </>
        )}
      </Show>
      <WizardSteps setup={props.setup} actions={props.actions} rowKeys={rowKeys} />
    </>
  );
}

export function CustodianSetupCard(props: {
  store: CustodianSessionStore;
  actions: CustodianSetupActions;
}) {
  const context = useApplication();
  const source = createMemo(() => props.store);
  const projection = createMemo(() => projectOwner(source(), (store) => store.autoSetup));
  const setup = () => projection().read();
  const native = context.nativeDeviceSettings
    ? projectOwner(context.nativeDeviceSettings, () => nativeSetupCapability(context)).read
    : () => nativeSetupCapability(context);
  const busy = () => {
    const current = setup();
    return (
      props.actions.verifying ||
      props.actions.answering ||
      current.pending ||
      current.wizard.state.phase === "starting" ||
      current.wizard.state.phase === "step"
    );
  };
  const gatewayHost = () => {
    try {
      return new URL(context.gateway.connection.gatewayUrl).hostname;
    } catch {
      return "";
    }
  };
  const local = () => {
    const kind = native()?.currentGateway?.kind;
    return kind ? kind === "local" : isLoopbackHostname(gatewayHost());
  };
  // A loopback address means nothing to the user; a remote host name does.
  const gatewayLabel = () =>
    native()?.currentGateway?.name || (local() ? undefined : gatewayHost());
  const stepIndex = () => STEPS.indexOf(setup().step);
  const go = (step: SetupStep) => setup().setStep(step);
  return (
    <openclaw-custodian-setup-card>
      <Show when={setup().supported && !setup().dismissed}>
        <section class="custodian-setup" aria-label={t("custodian.autoSetup.title")}>
          <button
            class="custodian__nudge-dismiss custodian-setup__dismiss"
            type="button"
            aria-label={t("common.dismiss")}
            onClick={() => setup().dismiss()}
          >
            <Icon name="x" />
          </button>
          <Show
            when={!setup().ready}
            fallback={
              <header class="custodian-setup__page custodian-setup__page--done">
                <span class="custodian-setup__row">
                  <Icon name="circleCheck" />
                </span>
                <h2>{t("custodian.autoSetup.doneTitle")}</h2>
              </header>
            }
          >
            <div class="custodian-setup__page">
              <Show when={setup().step === "welcome"}>
                <h2>{t("custodian.autoSetup.welcomeTitle")}</h2>
                <p class="muted">{t("custodian.autoSetup.welcomeSubtitle")}</p>
                <p class="muted">{t("custodian.autoSetup.welcomeBody")}</p>
                <div class="callout custodian-setup__stack">
                  <For
                    each={
                      [
                        ["wandSparkles", "featureAskTitle", "featureAskBody"],
                        ["messageSquare", "featureChatTitle", "featureChatBody"],
                        ["hand", "featureControlTitle", "featureControlBody"],
                      ] as const satisfies readonly (readonly [IconName, string, string])[]
                    }
                  >
                    {(feature) => (
                      <div class="custodian-setup__row">
                        <Icon name={feature[0]} />
                        <div class="option-card__choice-copy">
                          <strong>{t(`custodian.autoSetup.${feature[1]}`)}</strong>
                          <span class="option-card__description">
                            {t(`custodian.autoSetup.${feature[2]}`)}
                          </span>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
                <p class="muted custodian-setup__row">
                  <Icon name="info" />
                  <span>{t("custodian.autoSetup.safety")}</span>
                </p>
              </Show>
              <Show when={setup().step === "where"}>
                <h2>{t("custodian.autoSetup.whereTitle")}</h2>
                <p class="muted">{t("custodian.autoSetup.whereBody")}</p>
                <div class="callout custodian-setup__stack">
                  <ChoiceRow
                    icon={<Icon name={local() ? "monitor" : "server"} />}
                    title={t(
                      local()
                        ? "custodian.autoSetup.whereLocal"
                        : "custodian.autoSetup.whereRemote",
                    )}
                    detail={gatewayLabel()}
                    selected
                    trailing={<Icon name="circleCheck" />}
                  />
                  <Show when={native()?.openGateways}>
                    {(openGateways) => (
                      <button
                        class="btn btn--ghost btn--sm"
                        type="button"
                        onClick={() => openGateways()()}
                      >
                        {t("custodian.autoSetup.differentGateway")}
                      </button>
                    )}
                  </Show>
                </div>
              </Show>
              <Show when={setup().step === "ai"}>
                <h2>{t("custodian.autoSetup.aiTitle")}</h2>
                <p class="muted">{t("custodian.autoSetup.aiBody")}</p>
                <div class="custodian-setup__stack">
                  <ConnectAi setup={setup} actions={props.actions} busy={busy} />
                </div>
              </Show>
            </div>
            <footer class="custodian-setup__footer">
              <div class="custodian-setup__row">
                <Show when={stepIndex() > 0}>
                  <button
                    class="btn btn--ghost"
                    type="button"
                    disabled={busy()}
                    onClick={() => go(STEPS[stepIndex() - 1]!)}
                  >
                    {t("custodian.autoSetup.back")}
                  </button>
                </Show>
                <Show when={native()?.reviewPermissions}>
                  {(review) => (
                    <button class="btn btn--ghost" type="button" onClick={() => review()()}>
                      {t("custodian.autoSetup.reviewPermissions")}
                    </button>
                  )}
                </Show>
              </div>
              <ol
                class="custodian-setup__dots"
                aria-label={t("custodian.autoSetup.stepLabel", {
                  current: String(stepIndex() + 1),
                  total: String(STEPS.length),
                })}
              >
                <For each={STEPS}>
                  {(_step, index) => (
                    <li
                      class={{ "is-current": index() === stepIndex() }}
                      aria-current={index() === stepIndex() ? "step" : undefined}
                    />
                  )}
                </For>
              </ol>
              <div style={{ "justify-self": "end" }}>
                <Show when={stepIndex() < STEPS.length - 1}>
                  <button
                    class="btn primary"
                    type="button"
                    onClick={() => go(STEPS[stepIndex() + 1]!)}
                  >
                    {t("custodian.autoSetup.next")}
                  </button>
                </Show>
              </div>
            </footer>
          </Show>
        </section>
      </Show>
    </openclaw-custodian-setup-card>
  );
}
