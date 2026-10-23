import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  isPending,
  latest,
  Loading,
  Match,
  refresh,
  Show,
  Switch,
} from "solid-js";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import type { ConfigAutoSaveStatus } from "../lib/config/config-state-model.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createTimeout } from "../lib/reactive/timers.ts";
import { ConfigError } from "./config-error.tsx";
import { Icon } from "./solid/icon.tsx";
import { ThemeBrandingIcon } from "./theme-brand-icon.tsx";

registerSettingsEnglish();

const SAVED_VISIBLE_MS = 2_000;

export type SettingsSaveIndicatorProps = {
  status: ConfigAutoSaveStatus | "recovery";
  lastError: string | null;
  needsApply: boolean;
  saving: boolean;
  applying: boolean;
  applyDisabled: boolean;
  presentationRetired: () => Promise<void>;
  onRetry: () => Promise<unknown>;
  onSave: () => Promise<unknown>;
  onReload: () => Promise<unknown>;
  onApply: () => Promise<unknown>;
};

function IndicatorAction(props: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      class="btn btn--xs settings-save-indicator__action"
      type="button"
      disabled={props.busy}
      onClick={() => props.onClick()}
    >
      {props.label}
    </button>
  );
}

function Claw(props: { saved?: boolean }) {
  return (
    <span
      class={[
        "settings-save-indicator__claw",
        {
          "settings-save-indicator__claw--saved": props.saved,
          "settings-save-indicator__claw--saving": !props.saved,
        },
      ]}
      aria-hidden="true"
    >
      <ThemeBrandingIcon claw={<Icon name="claw" />} />
    </span>
  );
}

export function SettingsSaveIndicator(props: SettingsSaveIndicatorProps) {
  type Command = "retry" | "save" | "reload" | "apply";
  const lifetime = createMemo(() => ({ retired: props.presentationRetired() }), {
    equals: (previous, next) => previous.retired === next.retired,
  });
  const presentation = createMemo(() => {
    const { retired } = lifetime();
    const [command, setCommand] = createOptimistic<Command | null>(null);
    const [saving, setSaving] = createOptimistic(false);
    const needsApply = createMemo(() => props.needsApply);
    return { retired, command, setCommand, saving, setSaving, needsApply };
  });
  const [completion, setCompletion] = createSignal<Promise<unknown> | null>(null);
  const outcome = createMemo(async () => {
    await completion();
    return null;
  });
  const current = (view: ReturnType<typeof presentation>) =>
    view.retired === props.presentationRetired();
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<unknown>,
    retired: Promise<void>,
    command: Command,
  ) {
    try {
      if (current(view)) {
        view.setCommand(command);
        view.setSaving(true);
        // The owner decides whether the accepted operation still needs an Apply.
        affects(view.needsApply);
      }
      yield Promise.race([pending, retired]);
      if (current(view)) {
        yield refresh(view.needsApply);
      }
    } catch (error) {
      if (current(view)) {
        throw error;
      }
    }
  });
  function submit(command: Command) {
    const view = presentation();
    const retired = props.presentationRetired();
    if (busy() || (command === "apply" && props.applyDisabled)) {
      return;
    }
    const pending =
      command === "retry"
        ? props.onRetry()
        : command === "save"
          ? props.onSave()
          : command === "reload"
            ? props.onReload()
            : props.onApply();
    // Reload publishes its editor lock after draining writes. Keep that read
    // outside the write action so the lock can land before the read finishes.
    void setCompletion(
      command === "reload"
        ? Promise.race([pending, retired]).catch((error: unknown) => {
            if (current(view)) {
              throw error;
            }
          })
        : Promise.resolve().then(() => present(view, pending, retired, command)),
    );
  }
  const saving = () => presentation().saving();
  const busy = () => saving() || isPending(outcome);
  const status = createMemo(() => (props.saving ? "saving" : props.status));
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
    const command = presentation().command();
    if ((saving() && command === "apply") || props.applying) {
      return "applying";
    }
    if (saving() && (command === "save" || command === "retry")) {
      return "saving";
    }
    if (["saving", "recovery", "rejected", "error", "paused", "conflict"].includes(status())) {
      return status();
    }
    return saved() === "saved-visible"
      ? "saved"
      : latest(presentation().needsApply)
        ? "apply"
        : undefined;
  });
  function Feedback(feedback: { error?: string }) {
    return (
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
        aria-busy={busy() ? "true" : undefined}
        title={feedback.error}
        aria-label={
          feedback.error ? `${t("configView.autoSaveFailed")}: ${feedback.error}` : undefined
        }
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
            <IndicatorAction
              label={busy() ? t("common.loading") : t("configView.recoveryReload")}
              busy={busy()}
              onClick={() => submit("reload")}
            />
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
            <IndicatorAction
              label={t("configView.retry")}
              busy={busy()}
              onClick={() => submit("retry")}
            />
            <IndicatorAction
              label={busy() ? t("common.loading") : t("configView.recoveryReload")}
              busy={busy()}
              onClick={() => submit("reload")}
            />
          </Match>
          <Match when={state() === "error"}>
            <span>{t("configView.autoSaveFailed")}</span>
            <IndicatorAction
              label={t("configView.retry")}
              busy={busy()}
              onClick={() => submit("retry")}
            />
          </Match>
          <Match when={state() === "paused"}>
            <span>{t("configView.autoSavePaused")}</span>
            <IndicatorAction
              label={t("configView.saveNow")}
              busy={busy()}
              onClick={() => submit("save")}
            />
          </Match>
          <Match when={state() === "conflict"}>
            <span>{t("configView.autoSaveConflict")}</span>
            <IndicatorAction
              label={busy() ? t("common.loading") : t("common.reload")}
              busy={busy()}
              onClick={() => submit("reload")}
            />
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
              disabled={busy() || props.applyDisabled}
              onClick={() => submit("apply")}
            >
              {t("configView.applyChanges")}
            </button>
          </Match>
        </Switch>
      </div>
    );
  }
  return (
    <openclaw-settings-save-indicator>
      <Loading>
        <Show when={state()}>
          <ConfigError
            message={state() === "error" ? props.lastError?.trim() : undefined}
            fallback={<Feedback />}
          >
            {(message) => <Feedback error={message} />}
          </ConfigError>
        </Show>
      </Loading>
      <Errored fallback={(error) => <p role="alert">{formatUiError(error())}</p>}>
        <Loading on={latest(completion)}>{outcome()}</Loading>
      </Errored>
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
