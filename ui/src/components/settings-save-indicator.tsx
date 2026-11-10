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
import { registerSettingsSidebarEnglish } from "../i18n/locales/en-settings-sidebar.ts";
import type { ConfigAutoSaveStatus } from "../lib/config/config-state-model.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { ConfigError } from "./config-error.tsx";
import { showConfirmDialog } from "./confirm-dialog.ts";

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

type FailureKind = "error" | "rejected" | "recovery" | "deferred";
type Failure = { kind: FailureKind; reason: string | null };

const isFailure = (state: string | undefined): state is FailureKind =>
  state === "error" || state === "rejected" || state === "recovery" || state === "deferred";

export function SettingsSaveIndicator(props: SettingsSaveIndicatorProps) {
  type Command = "retry" | "save" | "reload" | "apply";
  const lifetime = createMemo(() => ({ retired: props.presentationRetired() }), {
    equals: (previous, next) => previous.retired === next.retired,
  });
  const presentation = createMemo(() => {
    const { retired } = lifetime();
    const [command, setCommand] = createOptimistic<{ kind: Command; failure?: Failure } | null>(
      null,
    );
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
    command: { kind: Command; failure?: Failure },
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
    // Capture before the owner clears its failure while admitting the retry.
    const presentedCommand = {
      kind: command,
      failure: command === "retry" ? failure() : undefined,
    };
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
        : Promise.resolve().then(() => present(view, pending, retired, presentedCommand)),
    );
  }
  const saving = () => presentation().saving();
  const busy = () => saving() || isPending(outcome);
  const status = createMemo(() => (props.saving ? "saving" : props.status));
  const state = createMemo(() => {
    const command = presentation().command();
    if ((saving() && command?.kind === "apply") || props.applying) {
      return "applying";
    }
    if (saving() || status() === "saving") {
      return "saving";
    }
    if (["recovery", "rejected", "error", "deferred", "paused", "conflict"].includes(status())) {
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
  // Retry keeps the failure in place until it has an outcome, so the card does not
  // collapse into Saving… and grow back when the same write fails again.
  const retrying = () => saving() && presentation().command()?.kind === "retry";
  const failure = createMemo<Failure | undefined>(
    () => {
      if (retrying()) {
        return presentation().command()?.failure;
      }
      const shown = state();
      if (isFailure(shown)) {
        return { kind: shown, reason: props.lastError?.trim() || null };
      }
      return undefined;
    },
    {
      equals: (previous, next) =>
        previous?.kind === next?.kind && previous?.reason === next?.reason,
    },
  );
  // Discarding drops edits the Gateway never saved, so it always asks first.
  function discard() {
    if (busy()) {
      return;
    }
    void showConfirmDialog({
      title: t("configView.discardChangesTitle"),
      message: t("configView.discardChangesMessage"),
      confirmLabel: t("configView.discardChanges"),
      danger: true,
    }).then((confirmed) => {
      if (confirmed) {
        submit("reload");
      }
    });
  }
  function FailureCard(card: { failure: Failure; reason: string | null }) {
    return (
      <div
        class={[
          "settings-save-indicator settings-save-indicator--failure",
          { "settings-save-indicator--retrying": retrying() },
        ]}
        role="status"
        aria-live="polite"
        aria-busy={busy() ? "true" : undefined}
      >
        <span class="settings-save-indicator__title">
          {retrying()
            ? t("configView.autoSaveSaving")
            : card.failure.kind === "rejected"
              ? t("configView.autoSaveRejected")
              : card.failure.kind === "deferred"
                ? t("configView.autoSaveDeferred")
                : t("configView.autoSaveFailed")}
        </span>
        <Show when={card.reason}>
          {(reason) => <p class="settings-save-indicator__reason">{reason()}</p>}
        </Show>
        <div class="settings-save-indicator__actions">
          <Show when={card.failure.kind !== "recovery"}>
            <button
              class="btn btn--sm primary settings-save-indicator__action"
              type="button"
              disabled={busy()}
              onClick={() => submit("retry")}
            >
              {t("configView.retry")}
            </button>
          </Show>
          <Show when={card.failure.kind !== "deferred" || props.pending}>
            <button
              class="btn btn--sm btn--ghost settings-save-indicator__action"
              type="button"
              disabled={busy()}
              onClick={discard}
            >
              {t("configView.discardChanges")}
            </button>
          </Show>
        </div>
      </div>
    );
  }
  function Feedback(feedback: { error?: string }) {
    return (
      <Show
        when={failure()}
        fallback={
          <div
            class={[
              "settings-save-indicator",
              {
                "settings-save-indicator--transient": state() === "saving" || state() === "saved",
                "settings-save-indicator--saved": state() === "saved",
              },
            ]}
            role="status"
            aria-live="polite"
            aria-busy={busy() ? "true" : undefined}
          >
            <Switch>
              <Match when={state() === "saving"}>
                <span>{t("configView.autoSaveSaving")}</span>
              </Match>
              <Match when={state() === "saved"}>
                <span>{t("configView.autoSaveSaved")}</span>
              </Match>
              <Match when={state() === "applying"}>
                <span class="btn__spinner settings-save-indicator__spinner" aria-hidden="true" />
                <span>{t("configView.applying")}</span>
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
                <span class="settings-save-indicator__failure">
                  {t("configView.autoSaveConflict")}
                </span>
                <IndicatorAction label={t("common.reload")} busy={busy()} onClick={discard} />
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
        }
      >
        {(shown) => (
          <FailureCard
            failure={shown()}
            reason={
              shown().kind === "error"
                ? (feedback.error?.replace(/^GatewayRequestError: /u, "") ?? null)
                : shown().reason
            }
          />
        )}
      </Show>
    );
  }
  return (
    <openclaw-settings-save-indicator>
      <Loading>
        <Show when={state() || failure()}>
          <ConfigError
            message={failure()?.kind === "error" ? (failure()?.reason ?? undefined) : undefined}
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
