import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { SystemAgentSetupDetectResult as SetupDetection } from "../../api/types.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ModelProviderIcon } from "../../lib/reactive/provider-presentation.tsx";
import type { CustodianSetupActions } from "./custodian-actions.ts";
import type { CustodianAutoSetup, SetupAuthOption, SetupFailure } from "./custodian-auto-setup.ts";
import {
  PLACEHOLDER_ROWS,
  ROW_COPY,
  setupPicker,
  type Row,
  type RowId,
} from "./custodian-setup-picker.ts";

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
        <Show when={props.failure.title}>{(title) => <strong>{title()}</strong>}</Show>
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
                {t("custodian.autoSetup.tryAgain")}
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

export function ChoiceRow(props: {
  icon: JSX.Element;
  title: JSX.Element;
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

/** Progress, sign-in steps and the failure of the choice being worked on. */
export function WizardSteps(props: {
  setup: () => CustodianAutoSetup;
  actions: CustodianSetupActions;
  retry?: () => void;
}) {
  const state = () => props.setup().wizard.state;
  const step = () => {
    const current = state();
    return current.phase === "step" ? current : undefined;
  };
  const progress = () =>
    state().phase === "starting" ? props.setup().attempt?.progress : undefined;
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
      <Show when={props.setup().attemptFailure}>
        {(failure) => <SetupError failure={failure()} retry={props.retry} />}
      </Show>
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
          </div>
        )}
      </Show>
      <Show when={props.setup().testing !== null}>
        <button
          class="btn btn--ghost"
          style={{ "justify-self": "start" }}
          type="button"
          disabled={props.actions.cancelling}
          onClick={() => void props.actions.cancel()}
        >
          {t("custodian.cancel")}
        </button>
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

/** The Mac's key form: a provider menu unless the row names one, a key, and Connect. */
function KeyForm(props: {
  providers: SetupDetection["manualProviders"];
  providerId?: string;
  busy: boolean;
  onConnect: (provider: SetupDetection["manualProviders"][number], key: string) => void;
}) {
  const [chosenId, setChosenId] = createSignal<string>();
  const provider = createMemo(() => {
    const id = props.providerId ?? chosenId();
    return props.providers.find((entry) => entry.id === id) ?? props.providers[0];
  });
  return (
    <form
      class="custodian-setup__stack"
      onSubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.elements.namedItem("key");
        const current = provider();
        if (!current || !(input instanceof HTMLInputElement) || input.disabled) {
          return;
        }
        const key = input.value.trim();
        if (key) {
          input.value = "";
          props.onConnect(current, key);
        }
      }}
    >
      <Show when={!props.providerId}>
        <label class="field">
          <span>{t("modelSetup.manual.provider")}</span>
          <select
            disabled={props.busy}
            onChange={(event) => setChosenId(event.currentTarget.value)}
          >
            <For each={props.providers}>
              {(entry) => (
                <option value={entry.id} selected={entry.id === provider()?.id}>
                  {entry.groupLabel ? `${entry.groupLabel}: ${entry.label}` : entry.label}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
      <label class="field">
        <span>{t("custodian.autoSetup.apiKey")}</span>
        <input
          name="key"
          type="password"
          autocomplete="off"
          required
          disabled={props.busy}
          placeholder={t("modelSetup.manual.accessValuePlaceholder")}
        />
      </label>
      <div class="custodian-setup__row" style={{ "justify-content": "space-between" }}>
        <span>
          <Show when={provider()?.website}>
            {(website) => (
              <a class="btn btn--ghost btn--sm" href={website()} target="_blank" rel="noreferrer">
                {t("custodian.autoSetup.findKey")}
                <Icon name="arrowUpRight" />
              </a>
            )}
          </Show>
        </span>
        <button class="btn primary" type="submit" disabled={props.busy}>
          {t("custodian.autoSetup.connect")}
        </button>
      </div>
    </form>
  );
}

/** The "Connect your AI" step: the Mac's provider list, and each pick on its own card. */
export function ConnectAi(props: {
  setup: () => CustodianAutoSetup;
  actions: CustodianSetupActions;
  busy: () => boolean;
  /** Detection runs on the Gateway host, which is not this computer for a remote Gateway. */
  local: () => boolean;
  /** A browser cannot open native setup; it names the CLI when nothing else can connect. */
  native: () => boolean;
}) {
  const [openId, setOpenId] = createSignal<RowId | null>(null);
  const [showMore, setShowMore] = createSignal(false);
  // The attempt that was current when the user last acted; only later results belong here.
  const [openedWith, setOpenedWith] = createSignal<unknown>(null);
  const detection = createMemo(() => props.setup().detection);
  const picker = createMemo(() => {
    const current = detection();
    return current ? setupPicker(current) : null;
  });
  const openRows = () => {
    const row = picker()?.rows.find((row) => row.id === openId());
    return row ? [row] : [];
  };
  const mark = () => {
    if (props.setup().testing === null) {
      setOpenedWith(() => props.setup().attempt);
    }
  };
  const ownAttempt = () => props.setup().attempt !== openedWith();
  const failure = () => (ownAttempt() ? props.setup().attemptFailure : null);
  const working = () => ownAttempt() && props.setup().testing !== null;

  const title = (row: Row) => {
    const copy = ROW_COPY[row.id];
    if (copy) {
      return t(`custodian.autoSetup.${copy.name}`);
    }
    return row.action.type === "candidate" ? row.action.candidate.label : "";
  };
  const subtitle = (row: Row, open: boolean) => {
    if (row.action.type === "candidate" && !ROW_COPY[row.id]) {
      return row.action.candidate.detail;
    }
    const body =
      row.id === "gemini" && row.action.type === "sign-in"
        ? "geminiSignInBody"
        : row.id === "api-key" && open
          ? "apiKeyOpenBody"
          : ROW_COPY[row.id]?.body;
    return body ? t(`custodian.autoSetup.${body}`) : "";
  };
  const icon = (row: Row) => {
    const brand =
      ROW_COPY[row.id]?.brand ??
      (row.action.type === "candidate"
        ? (row.action.candidate.brandId ?? row.action.candidate.kind)
        : undefined);
    if (brand) {
      return <ModelProviderIcon provider={brand} />;
    }
    return <Icon name={row.id === "api-key" ? "key" : "monitor"} />;
  };
  const badge = (row: Row) => (
    <Show when={row.detected}>
      {" "}
      <span class="chip chip-ok custodian-setup__badge">
        {t(props.local() ? "custodian.autoSetup.onThisComputer" : "custodian.autoSetup.onGateway")}
      </span>
    </Show>
  );
  const heading = (row: Row) => (
    <>
      {title(row)}
      {badge(row)}
    </>
  );

  const start = (row: Row) => {
    mark();
    const label = title(row);
    if (row.action.type === "candidate") {
      props.actions.activate(row.action.candidate, label);
    } else if (row.action.type === "sign-in") {
      props.actions.signIn(row.action.option, label);
    }
  };
  // Plain, not a signal: a second click can land before the list is replaced.
  let opening = false;
  const open = (row: Row) => {
    if (opening) {
      return;
    }
    opening = true;
    setOpenId(row.id);
    start(row);
  };
  const back = async () => {
    if (working() && !(await props.actions.cancel())) {
      return;
    }
    setOpenedWith(() => props.setup().attempt);
    opening = false;
    setOpenId(null);
  };
  const backLink = () => (
    <button
      class="btn btn--ghost btn--sm"
      style={{ "justify-self": "start" }}
      type="button"
      disabled={props.actions.cancelling}
      onClick={() => void back()}
    >
      <Icon name="chevronLeft" />
      {t("custodian.autoSetup.chooseAnother")}
    </button>
  );
  const checkAgain = () => (
    <button
      class="btn btn--sm"
      style={{ "justify-self": "start" }}
      type="button"
      disabled={props.busy()}
      onClick={() => props.actions.retry()}
    >
      {t("custodian.autoSetup.checkAgain")}
    </button>
  );
  const optionRow = (
    entry: { label: string; hint?: string; brandId?: string; id: string },
    action: string,
    run: () => void,
    fallback: IconName,
  ) => (
    <ChoiceRow
      icon={
        entry.brandId ? <ModelProviderIcon provider={entry.brandId} /> : <Icon name={fallback} />
      }
      title={entry.label}
      detail={entry.hint}
      disabled={props.busy()}
      trailing={<span class="option-card__description">{action}</span>}
      onClick={() => {
        mark();
        run();
      }}
    />
  );
  const download = (install: { label: string; hint: string; website: string; id: string }) => (
    <a class="option-card__choice" href={install.website} target="_blank" rel="noreferrer">
      <ModelProviderIcon provider={install.id} />
      <span class="option-card__choice-copy">
        <strong>{install.label}</strong>
        <span class="option-card__description">{install.hint}</span>
      </span>
      <span class="option-card__description">{t("custodian.autoSetup.download")} ↗</span>
    </a>
  );
  const localCard = () => {
    const current = picker()!;
    return (
      <>
        <For each={current.local}>
          {(candidate) =>
            optionRow(
              { id: candidate.kind, label: candidate.label, hint: candidate.detail },
              t("custodian.autoSetup.use"),
              () => props.actions.activate(candidate, candidate.label),
              "monitor",
            )
          }
        </For>
        <For each={current.prepareOptions}>
          {(option) =>
            optionRow(
              option,
              option.actionLabel ?? t("custodian.autoSetup.installAction"),
              () => props.actions.prepare(option),
              "download",
            )
          }
        </For>
        <For each={current.localAuthOptions}>
          {(option) =>
            optionRow(option, signInActionLabel(option), () => props.actions.signIn(option), "key")
          }
        </For>
        <For each={current.localDownloads}>{(install) => download(install)}</For>
        {checkAgain()}
      </>
    );
  };
  function ProviderCard(card: { row: Row }) {
    const action = () => card.row.action;
    const apiKeyAction = () => {
      const current = action();
      return current.type === "api-key" ? current : undefined;
    };
    return (
      <div class="callout custodian-setup__stack">
        <div class="custodian-setup__row">
          {icon(card.row)}
          <span class="option-card__choice-copy">
            <strong>{heading(card.row)}</strong>
            <span
              class="option-card__description"
              style={{ color: failure() ? "var(--warn)" : undefined }}
            >
              {failure()
                ? t("custodian.autoSetup.notConnected")
                : working()
                  ? t("custodian.autoSetup.connecting")
                  : subtitle(card.row, true)}
            </span>
          </span>
        </div>
        <Show when={ownAttempt()}>
          <WizardSteps
            setup={props.setup}
            actions={props.actions}
            retry={
              action().type === "candidate" || action().type === "sign-in"
                ? () => start(card.row)
                : undefined
            }
          />
        </Show>
        <Show when={apiKeyAction()}>
          {(keyAction) => (
            <KeyForm
              providers={picker()?.manualProviders ?? []}
              providerId={keyAction().providerId}
              busy={props.busy()}
              onConnect={(provider, key) => {
                mark();
                props.actions.connectKey(provider, key);
              }}
            />
          )}
        </Show>
        <Show when={!working()}>
          <Show when={action().type === "local"}>{localCard()}</Show>
          <Show
            when={
              card.row.id === "chatgpt" &&
              action().type === "candidate" &&
              failure() &&
              picker()?.chatgptSignIn
            }
          >
            {(option) => (
              <button
                class="btn"
                style={{ "justify-self": "start" }}
                type="button"
                disabled={props.busy()}
                onClick={() => {
                  mark();
                  props.actions.signIn(option(), title(card.row));
                }}
              >
                {t("custodian.autoSetup.signInChatgpt")}
              </button>
            )}
          </Show>
        </Show>
      </div>
    );
  }
  const moreProviders = () => {
    const current = picker()!;
    return (
      <div class="callout custodian-setup__stack">
        <For each={current.moreAuthOptions}>
          {(option) =>
            optionRow(option, signInActionLabel(option), () => props.actions.signIn(option), "key")
          }
        </For>
        <Show
          when={
            !current.manualProviders.length &&
            !current.moreAuthOptions.length &&
            !current.rows.length
          }
        >
          <div class="custodian-setup__stack">
            <strong>{t("custodian.autoSetup.noProvidersTitle")}</strong>
            <p class="muted">{t("custodian.autoSetup.noProvidersBody")}</p>
            {commandHint()}
          </div>
        </Show>
        <Show when={detection()?.unavailableCandidates?.length}>
          <strong class="muted">{t("custodian.autoSetup.notReady")}</strong>
          <For each={detection()?.unavailableCandidates}>
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
        </Show>
        <For each={current.otherInstalls}>{(install) => download(install)}</For>
        {checkAgain()}
      </div>
    );
  };
  const commandHint = () => (
    <Show when={!props.native()}>
      <p class="muted">
        {t("custodian.autoSetup.commandHint")} <code>openclaw onboard</code>
      </p>
    </Show>
  );
  // A sign-in from More providers has no row; its steps get a card of their own.
  const unplaced = () => ownAttempt() && openId() === null && props.setup().attempt !== null;

  return (
    <>
      <h2>{t("custodian.autoSetup.aiTitle")}</h2>
      <div class="custodian-setup__stack">
        <Show when={props.setup().error}>
          {(error) => (
            <>
              <SetupError
                failure={error()}
                retry={() => props.actions.retry()}
                disabled={props.busy()}
              />
              {commandHint()}
            </>
          )}
        </Show>
        <For
          each={openRows()}
          keyed={(row) => row.id}
          fallback={
            <Show
              when={!unplaced()}
              fallback={
                <>
                  {backLink()}
                  <div class="callout custodian-setup__stack">
                    <strong>{props.setup().attempt?.label}</strong>
                    <WizardSteps setup={props.setup} actions={props.actions} />
                  </div>
                </>
              }
            >
              <Show when={props.setup().pending}>
                <p class="custodian-setup__row" role="status">
                  <span class="btn__spinner" aria-hidden="true" />
                  {t("custodian.autoSetup.detecting")}
                </p>
              </Show>
              <div class="callout custodian-setup__list" style={{ padding: 0 }}>
                <Show
                  when={picker()}
                  fallback={
                    <For each={PLACEHOLDER_ROWS}>
                      {(id) => {
                        const row: Row = { id, action: { type: "local" }, detected: false };
                        return (
                          <ChoiceRow
                            icon={icon(row)}
                            title={title(row)}
                            detail={subtitle(row, false)}
                            disabled
                            trailing={<Icon name="chevronRight" />}
                          />
                        );
                      }}
                    </For>
                  }
                >
                  {(current) => (
                    <For each={current().rows}>
                      {(row) => (
                        <ChoiceRow
                          icon={icon(row)}
                          title={heading(row)}
                          detail={subtitle(row, false)}
                          disabled={props.busy()}
                          trailing={<Icon name="chevronRight" />}
                          onClick={() => open(row)}
                        />
                      )}
                    </For>
                  )}
                </Show>
              </div>
              <Show when={picker()}>
                <button
                  class="btn btn--ghost btn--sm"
                  style={{ "justify-self": "end" }}
                  type="button"
                  aria-expanded={showMore() ? "true" : "false"}
                  onClick={() => setShowMore((shown) => !shown)}
                >
                  {t("custodian.autoSetup.moreProviders")}
                </button>
                <Show when={showMore()}>{moreProviders()}</Show>
              </Show>
            </Show>
          }
        >
          {(row) => (
            <>
              {backLink()}
              <ProviderCard row={row()} />
            </>
          )}
        </For>
      </div>
    </>
  );
}
