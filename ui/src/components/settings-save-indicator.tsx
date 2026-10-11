import { createEffect, createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { currentThemeBranding, subscribeThemeBranding } from "../app/theme-branding.ts";
import type { ConfigAutoSaveStatus } from "../lib/config/config-state-model.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, LitContent } from "../lit/solid-bridge.ts";
import { icons } from "./icons.ts";
import { Icon } from "./solid/icon.tsx";
import { renderThemeBrandIcon } from "./theme-brand-icon.ts";

const SAVED_VISIBLE_MS = 2_000;

export type SettingsSaveIndicatorProps = {
  status: ConfigAutoSaveStatus | "recovery";
  lastError: string | null;
  needsApply: boolean;
  applying: boolean;
  applyDisabled: boolean;
  onRetry: () => void;
  onSave: () => void;
  onReload: () => void;
  onApply: () => void;
};

function action(label: string, onClick: () => void) {
  return (
    <button class="btn btn--xs settings-save-indicator__action" type="button" onClick={onClick}>
      {label}
    </button>
  );
}

function Claw(props: { saved?: boolean }) {
  const branding = projectSource(null, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  return (
    <span
      class={[
        "settings-save-indicator__claw",
        `settings-save-indicator__claw--${props.saved ? "saved" : "saving"}`,
      ]}
      aria-hidden="true"
    >
      <LitContent render={() => renderThemeBrandIcon(icons.claw, branding.read())} />
    </span>
  );
}

function SaveIndicatorContent(input: { props?: SettingsSaveIndicatorProps }) {
  const [savedVisible, setSavedVisible] = createSignal(false, { ownedWrite: true });
  createEffect(
    () => input.props?.status,
    (status, previous) => {
      if (previous === "saving" && status === "saved") {
        setSavedVisible(true);
        const timer = globalThis.setTimeout(() => setSavedVisible(false), SAVED_VISIBLE_MS);
        return () => globalThis.clearTimeout(timer);
      }
      if (status !== "saved") {
        setSavedVisible(false);
      }
      return undefined;
    },
  );
  const state = createMemo(() => {
    const props = input.props;
    if (!props) {
      return undefined;
    }
    if (props.applying) {
      return "applying";
    }
    if (["saving", "recovery", "rejected", "error", "paused", "conflict"].includes(props.status)) {
      return props.status;
    }
    if (savedVisible()) {
      return "saved";
    }
    return props.needsApply ? "apply" : undefined;
  });
  const title = () =>
    state() === "error" ? input.props?.lastError?.trim() || undefined : undefined;
  return (
    <Show when={input.props && state()}>
      <div
        class={[
          "settings-save-indicator",
          {
            "settings-save-indicator--danger": ["recovery", "error", "conflict"].includes(
              state() ?? "",
            ),
            "settings-save-indicator--recovery": state() === "recovery",
            "settings-save-indicator--rejected": state() === "rejected",
            "settings-save-indicator--saved": state() === "saved",
          },
        ]}
        role="status"
        aria-live="polite"
        title={title()}
        aria-label={title() ? `${t("configView.autoSaveFailed")}: ${title()}` : undefined}
      >
        <Switch>
          <Match when={state() === "applying"}>
            <span class="settings-save-indicator__spinner" aria-hidden="true">
              <Icon name="loader" />
            </span>
            <span>{t("configView.applying")}</span>
          </Match>
          <Match when={state() === "saving"}>
            <Claw />
            <span>{t("configView.autoSaveSaving")}</span>
          </Match>
          <Match when={state() === "recovery"}>
            <span>{input.props!.lastError}</span>
            {action(t("configView.recoveryReload"), () => input.props!.onReload())}
          </Match>
          <Match when={state() === "rejected"}>
            <span>{t("configView.autoSaveRejected")}</span>
            <span>{t("configView.autoSaveRejectedHint")}</span>
            <Show when={input.props!.lastError}>
              <details>
                <summary>{t("configView.rejectionDetails")}</summary>
                <span>{input.props!.lastError}</span>
              </details>
            </Show>
            {action(t("configView.retry"), () => input.props!.onRetry())}
            {action(t("configView.recoveryReload"), () => input.props!.onReload())}
          </Match>
          <Match when={state() === "error"}>
            <span>{t("configView.autoSaveFailed")}</span>
            {action(t("configView.retry"), () => input.props!.onRetry())}
          </Match>
          <Match when={state() === "paused"}>
            <span>{t("configView.autoSavePaused")}</span>
            {action(t("configView.saveNow"), () => input.props!.onSave())}
          </Match>
          <Match when={state() === "conflict"}>
            <span>{t("configView.autoSaveConflict")}</span>
            {action(t("common.reload"), () => input.props!.onReload())}
          </Match>
          <Match when={state() === "saved"}>
            <Claw saved />
            <span class="settings-save-indicator__check" aria-hidden="true">
              <Icon name="check" />
            </span>
            <span>{t("configView.autoSaveSaved")}</span>
          </Match>
          <Match when={state() === "apply"}>
            <button
              class="btn btn--xs settings-save-indicator__apply"
              type="button"
              disabled={input.props!.applyDisabled}
              onClick={() => input.props!.onApply()}
            >
              {t("configView.applyChanges")}
            </button>
          </Match>
        </Switch>
      </div>
    </Show>
  );
}

export const SettingsSaveIndicator = defineSolidBridge<{ props?: SettingsSaveIndicatorProps }>(
  "openclaw-settings-save-indicator",
  (props) => <SaveIndicatorContent props={props.props} />,
  {
    properties: { props: { default: undefined, attribute: false } },
  },
);
