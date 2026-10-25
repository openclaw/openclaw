import {
  Errored,
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  latest,
  onSettled,
} from "solid-js";
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
  const [completion, setCompletion] = createSignal<Promise<string | null>>();
  const message = createMemo(() => completion() ?? null, { loadingValue: null });
  const invalid = createMemo(
    () =>
      completion()?.then(
        (value) => Boolean(value),
        () => false,
      ) ?? false,
    { loadingValue: false },
  );
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
    // Keep owner publications outside the dialog's held transition so navigation can retire it.
    const result = Promise.resolve().then(() => submitOwner(objective));
    void setCompletion(result);
    try {
      if ((yield result) === null && !props.settled()) {
        props.finish();
      }
    } finally {
      submitting = false;
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
      <form
        class="exec-approval-card"
        onSubmit={(event) => {
          // The outcome slot observes rejection; consume it even if the modal retires.
          void submit(event).catch(() => undefined);
        }}
      >
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
            aria-invalid={!pending() && invalid() ? "true" : undefined}
            onInput={(event) => setDraft(event.currentTarget.value)}
            autofocus
          />
        </label>
        <Show when={!pending()}>
          <Errored
            fallback={(error) => (
              <div class="exec-approval-error" role="alert">
                {formatUiError(error())}
              </div>
            )}
          >
            <Show when={message()}>
              <div class="exec-approval-error" role="alert">
                {message()}
              </div>
            </Show>
          </Errored>
        </Show>
        <openclaw-modal-actions class="exec-approval-actions">
          <button class="btn" type="button" disabled={pending()} onClick={() => props.finish()}>
            {t("common.cancel")}
          </button>
          <button class="btn primary" type="submit" disabled={pending() || unchanged()}>
            {t("chat.goals.save")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}

/** Controlled mobile interior. The host owns the state title, navigation and domain facts. */
export function ChatDetailsGoal(props: ChatDetailsGoalProps) {
  let editDialog: { controller: AbortController; identity: string } | undefined;
  const [editAttempt, setEditAttempt] = createSignal<{ identity: string; result: Promise<void> }>();
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

  const editGoal = (goal: SessionGoal) => {
    if (editDialog || !canAct() || !props.onGoalSubmit) {
      return;
    }
    const sessionId = props.sessionId;
    const controller = new AbortController();
    const identity = goalIdentity();
    editDialog = { controller, identity };
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
    const result = (async () => {
      try {
        await withPromiseModalHost<void>(
          { signal: controller.signal, value: undefined },
          (modal) => {
            modal.render(() => (
              <GoalEditDialog
                objective={goal.objective}
                submit={submit}
                finish={() => modal.finish(undefined)}
                settled={() => modal.settled}
              />
            ));
          },
        );
      } finally {
        if (editDialog?.controller === controller) {
          editDialog = undefined;
        }
      }
    })();
    setEditAttempt({ identity, result });
    void result.catch(() => undefined);
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
        <Show
          when={props.presented && editAttempt()?.identity === goalIdentity() && editAttempt()}
          keyed
        >
          {(attempt) => {
            const completed = createMemo(() => attempt.result.then(() => null), {
              loadingValue: null,
            });
            return (
              <Errored
                fallback={(error) => (
                  <div class="exec-approval-error" role="alert">
                    {formatUiError(error())}
                  </div>
                )}
              >
                {latest(completed)}
              </Errored>
            );
          }}
        </Show>
        <Show when={props.recovery}>
          <div class="chat-details-goal__recovery" role="status">
            <ChatGoalRecoveryMessage recovery={props.recovery!} />
          </div>
        </Show>
        <Show
          when={props.goal}
          fallback={
            <PanelEmptyState
              presentation="mobile"
              icon={<GoalIcon />}
              heading={t("chat.goals.empty")}
              description=""
            />
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
                onGoalEdit={props.onGoalSubmit ? (goal) => editGoal(goal) : undefined}
              />
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
