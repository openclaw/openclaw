import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { resolveProviderIconName } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ModelProviderIcon } from "../../lib/reactive/provider-presentation.tsx";
import type { CustodianSetupActions } from "./custodian-actions.ts";
import type {
  CustodianAutoSetup,
  SetupAuthOption,
  SetupFailure,
  SetupManualProvider,
} from "./custodian-auto-setup.ts";

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

/** Progress, sign-in steps and the failure of the choice being worked on. */
function WizardSteps(props: { setup: () => CustodianAutoSetup; actions: CustodianSetupActions }) {
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
          <p class="custodian-setup__row" style={{ "justify-content": "center" }} role="status">
            <span class="btn__spinner" aria-hidden="true" />
            {text()}
          </p>
        )}
      </Show>
      <Show when={props.setup().attemptFailure}>
        {(failure) => <SetupError failure={failure()} />}
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

/**
 * A key field, or a sign-in for providers that sign in instead. One choice hides the
 * provider menu.
 */
function ProviderForm(props: {
  keys: SetupManualProvider[];
  signIns?: SetupAuthOption[];
  busy: boolean;
  onConnect: (provider: SetupManualProvider, key: string) => void;
  onSignIn?: (option: SetupAuthOption) => void;
}) {
  const choices = () => [
    ...props.keys.map((provider) => ({ id: `key:${provider.id}`, provider })),
    ...(props.signIns ?? []).map((option) => ({ id: `sign-in:${option.id}`, option })),
  ];
  const [selectedId, setSelectedId] = createSignal<string>();
  const selected = () => choices().find((entry) => entry.id === selectedId()) ?? choices()[0];
  return (
    <form
      class="custodian-setup__stack"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const current = selected();
        if (current && "option" in current) {
          props.onSignIn?.(current.option);
          return;
        }
        const value = new FormData(form).get("key");
        const key = typeof value === "string" ? value.trim() : "";
        if (current && key) {
          props.onConnect(current.provider, key);
          form.reset();
        }
      }}
    >
      <Show when={choices().length > 1}>
        <label class="field">
          <span>{t("modelSetup.manual.provider")}</span>
          <select
            disabled={props.busy}
            onChange={(event) => setSelectedId(event.currentTarget.value)}
          >
            <For each={choices()}>
              {(entry) => {
                const item = "option" in entry ? entry.option : entry.provider;
                return (
                  <option value={entry.id}>
                    {item.groupLabel ? `${item.groupLabel}: ${item.label}` : item.label}
                  </option>
                );
              }}
            </For>
          </select>
        </label>
      </Show>
      <Show when={selected() && !("option" in selected()!)}>
        <label class="field">
          <span>
            {t(
              choices().length > 1 ? "modelSetup.manual.accessValue" : "custodian.autoSetup.apiKey",
            )}
          </span>
          <input
            name="key"
            type="password"
            autocomplete="off"
            required
            disabled={props.busy}
            placeholder={t("modelSetup.manual.accessValuePlaceholder")}
          />
        </label>
      </Show>
      <div class="custodian-setup__row" style={{ "justify-content": "space-between" }}>
        <span>
          <Show
            when={(() => {
              const current = selected();
              return current && "provider" in current ? current.provider.website : undefined;
            })()}
          >
            {(website) => (
              <a class="btn btn--ghost btn--sm" href={website()} target="_blank" rel="noreferrer">
                {t("custodian.autoSetup.getKey")}
                <Icon name="arrowUpRight" />
              </a>
            )}
          </Show>
        </span>
        <button class="btn primary" type="submit" disabled={props.busy}>
          {(() => {
            const current = selected();
            return current && "option" in current
              ? signInActionLabel(current.option)
              : t("custodian.autoSetup.connect");
          })()}
        </button>
      </div>
    </form>
  );
}

/** One way to set a provider up on its card: use, connect, download, or a note. */
type Way = {
  title: string;
  detail?: string;
  action?: string;
  icon: () => JSX.Element;
  start?: () => void;
  href?: string;
};

type ProviderId = "chatgpt" | "claude" | "local" | "other";

/** The "Connect your AI" step: one row per provider, each set up on its own card. */
export function ConnectAi(props: {
  setup: () => CustodianAutoSetup;
  actions: CustodianSetupActions;
  busy: () => boolean;
}) {
  const [focus, setFocus] = createSignal<ProviderId | null>(null);
  // The attempt that was current when the user last acted; only later results belong here.
  const [openedWith, setOpenedWith] = createSignal<unknown>(null);
  const detection = () => props.setup().detection;
  const brand = (id: string) => resolveProviderIconName(id) ?? id;
  const logo = (id: string) => () => <ModelProviderIcon provider={id} />;
  // Utility-only choices (a setup helper model, not the assistant's model) cannot finish
  // first-run setup on their own, so the card leaves them to Model Setup.
  const primary = <T extends { modelTarget?: "utility" }>(entries: T[] | undefined) =>
    (entries ?? []).filter((entry) => entry.modelTarget !== "utility");
  const candidates = () => primary(detection()?.candidates);
  const authOptions = () => primary(detection()?.authOptions);
  const manualProviders = () => primary(detection()?.manualProviders);
  const prepareOptions = () => primary(detection()?.prepareOptions);
  // ChatGPT works as on main: test a stored Codex login first, otherwise sign in with the
  // Gateway's first ChatGPT sign-in.
  const isChatgptSignIn = (option: SetupAuthOption) =>
    option.brandId === "openai" && (option.kind === "oauth" || option.kind === "device-code");
  const chatgptLogin = () =>
    candidates().find(
      (candidate) => candidate.kind === "codex-cli" && candidate.credentials === true,
    );
  const chatgptSignIn = () => authOptions().find(isChatgptSignIn);
  // Claude is the easiest Claude setup there is: a Claude Code login the Gateway already
  // has, otherwise a Claude API key.
  const claudeCode = () => candidates().find((candidate) => candidate.kind === "claude-cli");
  const claudeKey = () => {
    const keys = manualProviders().filter(
      (provider) => brand(provider.brandId ?? provider.id) === "claude",
    );
    return keys.find((provider) => /api.?key/i.test(provider.id)) ?? keys[0];
  };
  // Local model apps: anything with a local setup, and downloads no sign-in claims.
  const localBrands = () => {
    const signInBrands = new Set(authOptions().map((option) => brand(option.brandId ?? option.id)));
    signInBrands.add(brand("openai"));
    signInBrands.add(brand("anthropic"));
    return new Set(
      [...prepareOptions(), ...(detection()?.recommendedInstalls ?? [])]
        .map((entry) => brand(entry.brandId ?? entry.id))
        .filter((id) => !signInBrands.has(id)),
    );
  };
  const isLocal = (candidate: { brandId?: string; kind: string }) =>
    localBrands().has(brand(candidate.brandId ?? candidate.kind));
  const localWays = createMemo<Way[]>(() => {
    const local = localBrands();
    const found = candidates().filter(isLocal);
    const usable = new Set(
      [
        ...found.map((candidate) => candidate.brandId ?? candidate.kind),
        ...prepareOptions().map((option) => option.brandId ?? option.id),
      ].map(brand),
    );
    return [
      ...found.map((candidate) => ({
        title: candidate.label,
        detail: candidate.detail,
        action: t("custodian.autoSetup.use"),
        icon: logo(candidate.brandId ?? candidate.kind),
        start: () => props.actions.activate(candidate),
      })),
      ...prepareOptions().map((option) => ({
        title: option.label,
        action: option.actionLabel ?? t("custodian.autoSetup.installAction"),
        icon: logo(option.brandId ?? option.id),
        start: () => props.actions.prepare(option),
      })),
      // No download for an app the card can already use or connect.
      ...(detection()?.recommendedInstalls ?? [])
        .filter((install) => {
          const id = brand(install.brandId ?? install.id);
          return local.has(id) && !usable.has(id);
        })
        .map((install) => ({
          title: install.label,
          action: t("custodian.autoSetup.download"),
          icon: logo(install.brandId ?? install.id),
          href: install.website,
        })),
      ...(detection()?.unavailableCandidates ?? [])
        .filter((candidate) => local.has(brand(candidate.brandId ?? candidate.id)))
        .map((candidate) => ({
          title: candidate.label,
          detail: candidate.reason,
          icon: () => <Icon name="info" />,
        })),
    ];
  });
  // Everything else the Gateway offers: AI it already found, keys and other sign-ins.
  const otherFound = () =>
    candidates().filter(
      (candidate) =>
        candidate.kind !== "codex-cli" && candidate.kind !== "claude-cli" && !isLocal(candidate),
    );
  const otherKeys = () => manualProviders().filter((provider) => provider !== claudeKey());
  const otherSignIns = () => authOptions().filter((option) => !isChatgptSignIn(option));
  const providers = (): ProviderId[] => {
    if (!detection()) {
      return [];
    }
    return [
      ...(chatgptLogin() || chatgptSignIn() ? (["chatgpt"] as const) : []),
      ...(claudeCode() || claudeKey() ? (["claude"] as const) : []),
      ...(localWays().length ? (["local"] as const) : []),
      ...(otherFound().length || otherKeys().length || otherSignIns().length
        ? (["other"] as const)
        : []),
    ];
  };
  const title = (id: ProviderId) =>
    t(
      {
        chatgpt: "custodian.autoSetup.chatgpt",
        claude: "custodian.autoSetup.claude",
        local: "modelSetup.prepare.title",
        other: "custodian.autoSetup.otherProvider",
      }[id],
    );
  const icon = (id: ProviderId) =>
    ({
      chatgpt: <ModelProviderIcon provider="openai" />,
      claude: <ModelProviderIcon provider="claude" />,
      local: <Icon name="cpu" />,
      other: <Icon name="key" />,
    })[id];
  // Results of attempts started before this point belong to an earlier choice.
  // A second click while the first choice runs belongs to that same attempt.
  const mark = () => {
    if (props.setup().testing === null) {
      setOpenedWith(() => props.setup().attempt);
    }
  };
  const ownAttempt = () => props.setup().attempt !== openedWith();
  const failure = () => (ownAttempt() ? props.setup().attemptFailure : null);
  const working = () => ownAttempt() && props.setup().testing !== null;
  // Plain, not a signal: a second click can land before the list is replaced, while a
  // signal written by the first click still reads its old value.
  let focused = false;
  const open = (id: ProviderId) => {
    if (focused) {
      return;
    }
    focused = true;
    mark();
    setFocus(id);
    // As on main, picking ChatGPT tests a login the Gateway already has.
    const login = chatgptLogin();
    if (id === "chatgpt" && login) {
      props.actions.activate(login);
    }
  };
  const backToList = () => {
    focused = false;
    setFocus(null);
  };
  const checkAgain = (label?: boolean) => (
    <button
      class="btn btn--ghost btn--sm"
      type="button"
      title={t("custodian.autoSetup.checkAgain")}
      aria-label={t("custodian.autoSetup.checkAgain")}
      disabled={props.busy()}
      onClick={() => props.actions.retry()}
    >
      <Icon name="refresh" />
      {label ? t("custodian.autoSetup.checkAgain") : null}
    </button>
  );
  const centered = { "justify-self": "center" } as const;
  const chatgptCard = () => {
    // After a failed sign-in, the button signs in again; after a failed login test, it
    // offers the sign-in instead.
    const signInFailed = () => failure()?.key === chatgptSignIn()?.id;
    return (
      <Show when={!working()}>
        <Show when={!failure()}>
          <p class="muted" style={{ "text-align": "center" }}>
            {t("custodian.autoSetup.chatgptBody")}
          </p>
        </Show>
        <button
          class="btn primary"
          style={centered}
          type="button"
          disabled={props.busy()}
          onClick={() => {
            const signIn = chatgptSignIn();
            const login = chatgptLogin();
            if (signIn) {
              mark();
              props.actions.signIn(signIn);
            } else if (login) {
              mark();
              props.actions.activate(login);
            }
          }}
        >
          {t(
            signInFailed() || !chatgptSignIn()
              ? "custodian.autoSetup.tryAgain"
              : "custodian.autoSetup.signInChatgpt",
          )}
        </button>
      </Show>
    );
  };
  const claudeCard = () => (
    <Show
      when={claudeCode()}
      fallback={
        <Show when={claudeKey()}>
          {(provider) => (
            <>
              <p class="muted" style={{ "text-align": "center" }}>
                {t("custodian.autoSetup.claudeKeyBody")}
              </p>
              <ProviderForm
                keys={[provider()]}
                busy={props.busy()}
                onConnect={(entry, key) => {
                  mark();
                  props.actions.connectKey(entry, key);
                }}
              />
            </>
          )}
        </Show>
      }
    >
      {(login) => (
        <button
          class="btn primary"
          style={centered}
          type="button"
          disabled={props.busy()}
          onClick={() => {
            mark();
            props.actions.activate(login());
          }}
        >
          {t("custodian.autoSetup.claudeCodeLogin")}
        </button>
      )}
    </Show>
  );
  const wayRow = (way: Way) =>
    way.href ? (
      <a class="option-card__choice" href={way.href} target="_blank" rel="noreferrer">
        {way.icon()}
        <span class="option-card__choice-copy">
          <strong>{way.title}</strong>
        </span>
        <span class="option-card__description">{way.action} ↗</span>
      </a>
    ) : way.start ? (
      <ChoiceRow
        icon={way.icon()}
        title={way.title}
        detail={way.detail}
        disabled={props.busy()}
        trailing={<span class="option-card__description">{way.action}</span>}
        onClick={() => {
          mark();
          way.start!();
        }}
      />
    ) : (
      <div class="custodian-setup__row">
        {way.icon()}
        <span class="option-card__choice-copy">
          <strong>{way.title}</strong>
          <span class="option-card__description">{way.detail}</span>
        </span>
      </div>
    );
  const otherCard = () => (
    <>
      <For each={otherFound()}>
        {(candidate) =>
          wayRow({
            title: candidate.label,
            detail: candidate.detail,
            action: t("custodian.autoSetup.use"),
            icon: logo(candidate.brandId ?? candidate.kind),
            start: () => props.actions.activate(candidate),
          })
        }
      </For>
      <Show when={otherKeys().length || otherSignIns().length}>
        <ProviderForm
          keys={otherKeys()}
          signIns={otherSignIns()}
          busy={props.busy()}
          onConnect={(entry, key) => {
            mark();
            props.actions.connectKey(entry, key);
          }}
          onSignIn={(option) => {
            mark();
            props.actions.signIn(option);
          }}
        />
      </Show>
    </>
  );
  const catalogs = () =>
    detection()?.nativeSessionCatalogPreferenceRequired
      ? (detection()?.nativeSessionCatalogs ?? [])
      : [];
  return (
    <Show
      when={focus()}
      fallback={
        <>
          <h2>{t("custodian.autoSetup.aiTitle")}</h2>
          <p class="muted">{t("custodian.autoSetup.aiBody")}</p>
          <div class="custodian-setup__stack">
            <Show when={props.setup().error}>
              {(error) => (
                <SetupError
                  failure={error()}
                  retry={() => props.actions.retry()}
                  disabled={props.busy()}
                />
              )}
            </Show>
            <Show when={!detection() && props.setup().pending}>
              <p class="custodian-setup__row" role="status">
                <span class="btn__spinner" aria-hidden="true" />
                {t("custodian.autoSetup.detecting")}
              </p>
            </Show>
            <Show when={detection()}>
              <span style={{ "justify-self": "end" }}>{checkAgain(true)}</span>
            </Show>
            <For each={providers()}>
              {(id) => (
                <ChoiceRow
                  icon={icon(id)}
                  title={title(id)}
                  disabled={props.busy()}
                  trailing={<Icon name="chevronRight" />}
                  onClick={() => open(id)}
                />
              )}
            </For>
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
          </div>
        </>
      }
    >
      {(id) => (
        <>
          <div
            style={{
              display: "grid",
              "grid-template-columns": "1fr auto 1fr",
              "align-items": "center",
              width: "100%",
            }}
          >
            <button
              class="btn btn--ghost btn--sm"
              style={{ "justify-self": "start" }}
              type="button"
              disabled={props.setup().testing !== null}
              onClick={backToList}
            >
              <Icon name="chevronLeft" />
              {t("custodian.autoSetup.allChoices")}
            </button>
            <h2 class="custodian-setup__row">
              {icon(id())}
              {title(id())}
            </h2>
            <span style={{ "justify-self": "end" }}>
              <Show when={id() === "local"}>{checkAgain()}</Show>
            </span>
          </div>
          <div class="custodian-setup__stack">
            <Show when={id() === "local"}>
              <For each={localWays()}>{(way) => wayRow(way)}</For>
            </Show>
            <Show when={id() === "other"}>{otherCard()}</Show>
            <Show when={ownAttempt()}>
              <WizardSteps setup={props.setup} actions={props.actions} />
            </Show>
            <Show when={working()}>
              <button
                class="btn btn--ghost"
                style={centered}
                type="button"
                disabled={props.actions.cancelling}
                onClick={() => props.actions.cancel()}
              >
                {t("custodian.cancel")}
              </button>
            </Show>
            <Show when={id() === "chatgpt"}>{chatgptCard()}</Show>
            <Show when={id() === "claude" && !working()}>{claudeCard()}</Show>
          </div>
        </>
      )}
    </Show>
  );
}
