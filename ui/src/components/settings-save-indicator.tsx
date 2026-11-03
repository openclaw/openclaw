import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createSignal,
  createUniqueId,
  Errored,
  isPending,
  latest,
  Loading,
  Match,
  refresh,
  Show,
  Switch,
} from "solid-js";
import { registerSettingsSidebarEnglish } from "../i18n/locales/en-settings-sidebar.ts";
import type { ConfigAutoSaveStatus } from "../lib/config/config-state-model.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { ConfigError } from "./config-error.tsx";
import { Icon } from "./solid/icon.tsx";

registerSettingsSidebarEnglish();

export type SettingsSaveIndicatorProps = {
  status: ConfigAutoSaveStatus | "recovery";
  lastError: string | null;
  needsApply: boolean;
  /** Edits waiting on their autosave, which runs a moment after the last change. */
  pending: boolean;
  savedNotice: boolean;
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

/** The raw reason opens beside the status instead of stretching it into a paragraph. */
function FailureReason(props: { reason: string }) {
  const [open, setOpen] = createSignal(false);
  const id = createUniqueId();
  return (
    <>
      <button
        class="settings-save-indicator__reason-toggle"
        type="button"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
      >
        {t(open() ? "configView.rejectionDetailsHide" : "configView.rejectionDetails")}
      </button>
      <div class="settings-save-indicator__reason" id={id} hidden={!open()}>
        {props.reason}
      </div>
    </>
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
  const state = createMemo(() => {
    const command = presentation().command();
    if ((saving() && command === "apply") || props.applying) {
      return "applying";
    }
    if (saving() || status() === "saving") {
      return "saving";
    }
    if (["recovery", "rejected", "error", "paused", "conflict"].includes(status())) {
      return status();
    }
    if (props.pending) {
      return "saving";
    }
    if (props.savedNotice) {
      return "saved";
    }
    return latest(presentation().needsApply) ? "apply" : undefined;
  });
  function RetryOrDiscard() {
    return (
      <div class="settings-save-indicator__actions">
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
      </div>
    );
  }
  function Feedback(feedback: { error?: string }) {
    return (
      <div
        class={[
          "settings-save-indicator",
          {
            "settings-save-indicator--recovery": state() === "recovery",
            "settings-save-indicator--rejected": state() === "rejected",
            "settings-save-indicator--error": state() === "error",
            "settings-save-indicator--transient": state() === "saving" || state() === "saved",
            "settings-save-indicator--saved": state() === "saved",
          },
        ]}
        role="status"
        aria-live="polite"
        aria-busy={busy() ? "true" : undefined}
        aria-label={
          feedback.error ? `${t("configView.autoSaveFailed")}: ${feedback.error}` : undefined
        }
      >
        <Switch>
          <Match when={state() === "saving"}>
            <span>{t("configView.autoSaveSaving")}</span>
          </Match>
          <Match when={state() === "saved"}>
            <span>{t("configView.autoSaveSaved")}</span>
          </Match>
          <Match when={state() === "applying"}>
            <span class="settings-save-indicator__spinner" aria-hidden="true">
              <Icon name="loader" />
            </span>
            <span>{t("configView.applying")}</span>
          </Match>
          <Match when={state() === "recovery"}>
            <span class="settings-save-indicator__failure">{props.lastError}</span>
            <IndicatorAction
              label={busy() ? t("common.loading") : t("configView.recoveryReload")}
              busy={busy()}
              onClick={() => submit("reload")}
            />
          </Match>
          <Match when={state() === "rejected"}>
            <span>{t("configView.autoSaveRejected")}</span>
            <span>{t("configView.autoSaveRejectedHint")}</span>
            <Show when={props.lastError}>{(reason) => <FailureReason reason={reason()} />}</Show>
            <RetryOrDiscard />
          </Match>
          <Match when={state() === "error"}>
            <span class="settings-save-indicator__failure">{t("configView.autoSaveFailed")}</span>
            <Show when={feedback.error}>
              {(error) => <FailureReason reason={error().replace(/^GatewayRequestError: /u, "")} />}
            </Show>
            <RetryOrDiscard />
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
            <span class="settings-save-indicator__failure">{t("configView.autoSaveConflict")}</span>
            <IndicatorAction
              label={busy() ? t("common.loading") : t("common.reload")}
              busy={busy()}
              onClick={() => submit("reload")}
            />
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
