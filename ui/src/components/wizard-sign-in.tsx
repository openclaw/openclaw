import { createMemo, createSignal, Show } from "solid-js";
import type { WizardStep } from "../api/types.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createInterval, createTimeout } from "../lib/reactive/timers.ts";
import { handleCopyButton } from "./copy-button-state.ts";
import { resolveProviderIconName } from "./provider-icon-data.ts";
import { ProviderBrandIcon, ProviderFallbackIcon } from "./solid/provider-icon.tsx";
import "../styles/wizard-sign-in.css";

/** After this long without a callback, the tab most likely opened in another browser or profile. */
export const SIGN_IN_SLOW_MS = 45_000;
const EXPIRY_TICK_MS = 15_000;
const EXPIRY_VISIBLE_MINUTES = 5;

type ModelSetupSignInProps = {
  step: WizardStep;
  /** True when a browser callback or Gateway poll settles this step without another answer. */
  waiting: boolean;
  providerId?: string;
  providerLabel?: string;
  onAutofocusRef?: (element: HTMLElement) => void;
};

function CopyAction(props: { value: string; label: string; class: string }) {
  let label!: HTMLSpanElement;
  return (
    <button
      type="button"
      class={props.class}
      onClick={(event) => void handleCopyButton(event, props.value, props.label, { label })}
    >
      <span ref={(element) => (label = element)} data-copy-label>
        {props.label}
      </span>
    </button>
  );
}

function ProviderBadge(props: { providerId?: string; providerLabel?: string; waiting: boolean }) {
  const iconProvider = () =>
    props.providerId && resolveProviderIconName(props.providerId) ? props.providerId : undefined;
  return (
    <div class={["wizard-sign-in__badge", { "wizard-sign-in__badge--waiting": props.waiting }]}>
      <Show when={props.waiting}>
        <span class="wizard-sign-in__ring" aria-hidden="true" />
      </Show>
      <Show
        when={iconProvider()}
        fallback={
          <ProviderFallbackIcon
            label={props.providerLabel || props.providerId || "?"}
            class="wizard-sign-in__icon"
          />
        }
      >
        {(provider) => <ProviderBrandIcon provider={provider()} class="wizard-sign-in__icon" />}
      </Show>
    </div>
  );
}

/**
 * Model-setup browser sign-in: the runner has already opened the provider tab, so the
 * dialog only explains that, offers quiet recovery, and lets the poll finish the step.
 */
export function ModelSetupSignIn(props: ModelSetupSignInProps) {
  const code = createMemo(() => props.step.deviceCode);
  const provider = () => props.providerLabel || t("modelSetup.wizard.signInPage");
  const [slow, setSlow] = createSignal(false);
  createTimeout(
    () => setSlow(true),
    () => SIGN_IN_SLOW_MS,
  );
  // Progress updates that repeat the same lifetime keep the original deadline.
  const expiresInMinutes = createMemo(() => props.step.deviceCode?.expiresInMinutes);
  const expiresAt = createMemo(() => {
    const minutes = expiresInMinutes();
    return minutes === undefined ? undefined : Date.now() + minutes * 60_000;
  });
  const [now, setNow] = createSignal(Date.now());
  createInterval(
    () => setNow(Date.now()),
    () => (expiresAt() === undefined ? undefined : EXPIRY_TICK_MS),
  );
  const minutesLeft = () => {
    const deadline = expiresAt();
    return deadline === undefined ? undefined : Math.ceil((deadline - now()) / 60_000);
  };
  const expired = () => (minutesLeft() ?? 1) <= 0;
  const stillWaiting = () => props.waiting && slow() && !code();
  const lead = () => {
    // A step that waits for Continue carries the provider's own instructions.
    if (!props.waiting && props.step.message) {
      return formatUiExternalText(props.step.message);
    }
    const current = code();
    if (current) {
      return props.step.externalUrl
        ? t("modelSetup.wizard.deviceCodeOpened", { provider: provider() })
        : (current.message ?? t("modelSetup.wizard.deviceCodeEnter"));
    }
    return t(
      props.waiting ? "modelSetup.wizard.browserOpened" : "modelSetup.wizard.browserOpenedContinue",
      { provider: provider() },
    );
  };
  const status = () =>
    props.waiting
      ? stillWaiting()
        ? t("modelSetup.wizard.stillWaiting")
        : (props.step.progressMessage ??
          (props.providerLabel
            ? t("modelSetup.wizard.waitingForProvider", { provider: props.providerLabel })
            : t("modelSetup.wizard.waiting")))
      : "";
  return (
    <div class="wizard-sign-in">
      <ProviderBadge
        providerId={props.providerId}
        providerLabel={props.providerLabel}
        waiting={props.waiting && !expired()}
      />
      <h2 class="wizard-sign-in__title">
        {t(code() ? "modelSetup.wizard.deviceCodeTitle" : "modelSetup.wizard.signInTitle")}
      </h2>
      <p class="wizard-sign-in__lead">{lead()}</p>
      <span class="sr-only" role="status" aria-live="polite">
        {status()}
      </span>
      <Show when={stillWaiting()}>
        <div class="callout warning wizard-sign-in__callout">
          {t("modelSetup.wizard.stillWaiting")}
        </div>
      </Show>
      <Show when={expired()}>
        <div class="callout warning wizard-sign-in__callout" role="alert">
          {t("modelSetup.wizard.deviceCodeExpired")}
        </div>
      </Show>
      <Show when={!expired() && code()}>
        {(current) => (
          <div class="wizard-sign-in__code">
            <code class="wizard-step__sign-in-code">{current().code}</code>
            <CopyAction
              value={current().code}
              label={t("modelSetup.wizard.copyCode")}
              class="btn btn--sm"
            />
          </div>
        )}
      </Show>
      <Show when={!expired() && props.step.externalUrl}>
        {(url) => (
          <div class="wizard-sign-in__actions">
            <a
              ref={(element) => props.onAutofocusRef?.(element)}
              class={["btn", "wizard-step__external-link", { primary: stillWaiting() }]}
              autofocus
              data-link-reader-external
              href={url()}
              target="_blank"
              rel="noreferrer"
            >
              {t(stillWaiting() ? "modelSetup.wizard.tryAgain" : "modelSetup.wizard.reopenSignIn")}
            </a>
            <Show when={!code()}>
              <p class="wizard-sign-in__fallback">
                {t("modelSetup.wizard.tabDidNotOpen")}{" "}
                <CopyAction
                  value={url()}
                  label={t("modelSetup.wizard.copySignInLink")}
                  class="wizard-sign-in__link"
                />
              </p>
            </Show>
          </div>
        )}
      </Show>
      <Show when={!expired() && (minutesLeft() ?? Infinity) <= EXPIRY_VISIBLE_MINUTES}>
        <p class="wizard-sign-in__note">
          {(minutesLeft() ?? 0) > 1
            ? t("modelSetup.wizard.expires", { count: String(minutesLeft()) })
            : t("modelSetup.wizard.expiresSoon")}
        </p>
      </Show>
      <Show when={code()}>
        <p class="wizard-sign-in__note">{t("modelSetup.wizard.deviceCodeWarning")}</p>
      </Show>
    </div>
  );
}
