import { createMemo, createSignal, Match, Show, Switch } from "solid-js";
import type { ConfigAutoSaveStatus } from "../lib/config/config-state-model.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createTimeout } from "../lib/reactive/timers.ts";
import { Icon } from "./solid/icon.tsx";
import { ThemeBrandingIcon } from "./theme-brand-icon.tsx";

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
  return (
    <span
      class={[
        "settings-save-indicator__claw",
        `settings-save-indicator__claw--${props.saved ? "saved" : "saving"}`,
      ]}
      aria-hidden="true"
    >
      <ThemeBrandingIcon claw={<Icon name="claw" />} />
    </span>
  );
}

export function SettingsSaveIndicator(props: SettingsSaveIndicatorProps) {
  const status = createMemo(() => props.status);
  // Only a saving → saved transition starts a fresh display window.
  type SaveState = SettingsSaveIndicatorProps["status"] | "saved-visible";
  const [saved, setSaved] = createSignal<SaveState>((previous) =>
    previous === "saving" && status() === "saved" ? "saved-visible" : status(),
  );
  createTimeout(
    () => setSaved("saved"),
    () => (saved() === "saved-visible" ? SAVED_VISIBLE_MS : undefined),
  );
  const state = createMemo(() => {
    if (props.applying) {
      return "applying";
    }
    if (["saving", "recovery", "rejected", "error", "paused", "conflict"].includes(props.status)) {
      return props.status;
    }
    return saved() === "saved-visible" ? "saved" : props.needsApply ? "apply" : undefined;
  });
  const title = () => (state() === "error" ? props.lastError?.trim() || undefined : undefined);
  return (
    <openclaw-settings-save-indicator>
      <Show when={state()}>
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
              <span>{props.lastError}</span>
              {action(t("configView.recoveryReload"), () => props.onReload())}
            </Match>
            <Match when={state() === "rejected"}>
              <span>{t("configView.autoSaveRejected")}</span>
              <span>{t("configView.autoSaveRejectedHint")}</span>
              <Show when={props.lastError}>
                <details>
                  <summary>{t("configView.rejectionDetails")}</summary>
                  <span>{props.lastError}</span>
                </details>
              </Show>
              {action(t("configView.retry"), () => props.onRetry())}
              {action(t("configView.recoveryReload"), () => props.onReload())}
            </Match>
            <Match when={state() === "error"}>
              <span>{t("configView.autoSaveFailed")}</span>
              {action(t("configView.retry"), () => props.onRetry())}
            </Match>
            <Match when={state() === "paused"}>
              <span>{t("configView.autoSavePaused")}</span>
              {action(t("configView.saveNow"), () => props.onSave())}
            </Match>
            <Match when={state() === "conflict"}>
              <span>{t("configView.autoSaveConflict")}</span>
              {action(t("common.reload"), () => props.onReload())}
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
                disabled={props.applyDisabled}
                onClick={() => props.onApply()}
              >
                {t("configView.applyChanges")}
              </button>
            </Match>
          </Switch>
        </div>
      </Show>
    </openclaw-settings-save-indicator>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-settings-save-indicator": HTMLAttributes<HTMLElement>;
    }
  }
}
