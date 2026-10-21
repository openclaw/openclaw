import { Show, action, createMemo, createOptimistic, createSignal, onSettled } from "solid-js";
import type { SessionGoal } from "../../../api/types.ts";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import type {
  ChatGoalAction,
  ChatGoalDraft,
  ChatGoalRecovery,
} from "../../../lib/chat/chat-types.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/chat/details-goal.css";
import {
  ChatGoalActions,
  ChatGoalBody,
  ChatGoalMetrics,
  ChatGoalRecoveryAction,
  ChatGoalRecoveryMessage,
  GoalIcon,
} from "./chat-composer-goal.tsx";

export type ChatDetailsGoalProps = {
  goal?: SessionGoal;
  sessionId?: string;
  presented: boolean;
  connected: boolean;
  /** Native composer write availability, including admission and pending-operation guards. */
  canAct: boolean;
  recovery?: ChatGoalRecovery;
  onGoalAction?: (goalId: string, action: ChatGoalAction) => void;
  onGoalSubmit?: (draft: ChatGoalDraft, submissionAction?: Event) => Promise<boolean>;
  /** Reads the native owner's failure after submission settles. */
  getGoalSubmitError?: () => string | null | undefined;
  /** The sheet's scroll owner attaches its existing observer to this actual scrollport. */
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
};

/** The native modal owns focus/dismissal; this form preserves multiline objectives. */
function GoalEditDialog(props: {
  objective: string;
  submit: (objective: string) => Promise<string | null>;
  finish: () => void;
  settled: () => boolean;
}) {
  const [draft, setDraft] = createSignal(() => props.objective);
  const [pending, setPending] = createOptimistic(false);
  const [error, setError] = createSignal<string | null>(null);
  let submitting = false;
  let input!: HTMLTextAreaElement;
  const unchanged = () => !draft().trim() || draft() === props.objective;
  const submit = action(function* (
    event: SubmitEvent,
  ): Generator<Promise<string | null>, void, string | null> {
    event.preventDefault();
    if (submitting || unchanged()) {
      return;
    }
    submitting = true;
    setPending(true);
    const objective = input.value;
    const submitOwner = props.submit;
    let submissionError: string | null;
    try {
      // Keep owner publications outside the dialog's held transition so navigation can retire it.
      submissionError = yield Promise.resolve().then(() => submitOwner(objective));
    } catch (cause) {
      submissionError = formatUiError(cause);
    }
    if (props.settled()) {
      return;
    }
    submitting = false;
    if (submissionError === null) {
      props.finish();
    } else {
      setError(submissionError);
      onSettled(() => {
        if (!props.settled()) {
          input.focus();
        }
      });
    }
  });
  return (
    <openclaw-modal-dialog
      label={t("chat.goals.edit")}
      prop:initialFocus={() => input}
      onModal-cancel={(event: Event) => {
        if (submitting) {
          event.preventDefault();
        } else {
          props.finish();
        }
      }}
    >
      <form class="exec-approval-card" onSubmit={(event) => void submit(event)}>
        <div class="exec-approval-header">
          <div class="exec-approval-title">{t("chat.goals.edit")}</div>
        </div>
        <label class="field input-dialog__field">
          <span>{t("chat.goals.objectivePlaceholder")}</span>
          <textarea
            ref={(element) => {
              input = element;
            }}
            name="objective"
            rows={5}
            value={draft()}
            disabled={pending()}
            aria-invalid={!pending() && error() ? "true" : undefined}
            onInput={(event) => setDraft(event.currentTarget.value)}
            autofocus
          />
        </label>
        <Show when={!pending() && error()}>
          <div class="exec-approval-error" role="alert">
            {error()}
          </div>
        </Show>
        <openclaw-modal-actions class="exec-approval-actions">
          <button class="btn primary" type="submit" disabled={pending() || unchanged()}>
            {t("chat.goals.save")}
          </button>
          <button class="btn" type="button" disabled={pending()} onClick={() => props.finish()}>
            {t("common.cancel")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}

/** Controlled mobile interior. The host owns the state title, navigation and domain facts. */
export function ChatDetailsGoal(props: ChatDetailsGoalProps) {
  let editDialog: { controller: AbortController; identity: string } | undefined;
  const goalIdentity = createMemo(() => JSON.stringify([props.sessionId, props.goal?.id]));
  const canAct = () =>
    props.presented &&
    props.connected &&
    props.canAct &&
    Boolean(props.sessionId) &&
    !props.recovery;
  const resumeRecovery = () =>
    props.goal &&
    props.recovery?.action === "resume" &&
    !props.recovery.retired &&
    props.recovery.goalId === props.goal?.id
      ? props.recovery
      : undefined;

  const editGoal = async (goal: SessionGoal) => {
    if (editDialog || !canAct() || !props.onGoalSubmit) {
      return;
    }
    const sessionId = props.sessionId;
    const controller = new AbortController();
    editDialog = { controller, identity: goalIdentity() };
    const submit = async (objective: string): Promise<string | null> => {
      // The dialog can outlive its entry click; submit only against its original session/goal.
      if (
        controller.signal.aborted ||
        props.sessionId !== sessionId ||
        props.goal?.id !== goal.id
      ) {
        return t("chat.goals.sessionChanged");
      }
      if (!props.connected) {
        return t("chat.goals.offline");
      }
      if (props.recovery) {
        return t(props.recovery.pending ? "chat.goals.actionPending" : "chat.goals.outcomeUnknown");
      }
      if (!canAct() || props.goal.status === "complete" || !props.onGoalSubmit) {
        return t("chat.goals.editUnavailable");
      }
      const saved = await props.onGoalSubmit({
        action: "edit",
        sessionId,
        goalId: goal.id,
        objective,
      });
      return saved ? null : (props.getGoalSubmitError?.() ?? t("chat.goals.editFailed"));
    };
    try {
      await withPromiseModalHost<void>({ signal: controller.signal, value: undefined }, (modal) => {
        modal.render(() => (
          <GoalEditDialog
            objective={goal.objective}
            submit={submit}
            finish={() => modal.finish(undefined)}
            settled={() => modal.settled}
          />
        ));
      });
    } finally {
      if (editDialog?.controller === controller) {
        editDialog = undefined;
      }
    }
  };

  return (
    <div class="chat-details-goal" aria-busy={props.recovery?.pending ? "true" : "false"}>
      <Show when={props.presented && goalIdentity()} keyed>
        {(identity) => {
          onSettled(() => () => {
            if (editDialog?.identity === identity) {
              editDialog.controller.abort();
            }
          });
          return null;
        }}
      </Show>
      <div class="chat-details-goal__body" ref={[elementRef(props.onScrollPortRef)]}>
        <Show when={props.recovery}>
          <div class="chat-details-goal__recovery" role="status">
            <ChatGoalRecoveryMessage recovery={props.recovery!} />
          </div>
        </Show>
        <Show
          when={props.goal}
          fallback={
            <PanelEmptyState icon={<GoalIcon />} heading={t("chat.goals.empty")} description="" />
          }
        >
          <ChatGoalBody goal={props.goal!} resumeRecovery={resumeRecovery()} />
        </Show>
      </div>
      <div class="chat-details-goal__tools">
        <Show when={props.goal}>
          <div class="chat-details-goal__capsule chat-details-goal__metrics">
            <ChatGoalMetrics goal={props.goal!} live={props.presented} />
          </div>
        </Show>
        <Show when={props.recovery || (props.goal && canAct() && props.onGoalAction)}>
          <div class="chat-details-goal__capsule chat-details-goal__actions">
            <Show when={resumeRecovery()?.pending}>
              <span
                class="chat-details-goal__pending"
                role="status"
                aria-label={t("chat.goals.resuming")}
              >
                <span class="session-run-spinner" aria-hidden="true" />
              </span>
            </Show>
            <Show when={props.recovery && !resumeRecovery()}>
              <ChatGoalRecoveryAction
                recovery={props.recovery!}
                connected={props.connected && props.presented}
              />
            </Show>
            <Show when={props.goal}>
              <ChatGoalActions
                goal={props.goal!}
                canAct={canAct()}
                connected={props.connected && props.presented}
                resumeRecovery={resumeRecovery()}
                onGoalAction={props.onGoalAction}
                onGoalEdit={props.onGoalSubmit ? (goal) => void editGoal(goal) : undefined}
              />
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
