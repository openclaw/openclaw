import { Show } from "solid-js";
import "../../../styles/chat/composer-context-strip.css";
import type { SessionGoal } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import type { ChatGoalDraftMode } from "../../../lib/chat/chat-types.ts";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { commitComposerDraft, composerDraftKey } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

registerEnglishCatalog(registerChatGoalsEnglish);

export function createGoalComposer(readProps: () => ChatComposerProps, state: ChatComposerState) {
  const mode = () => readProps().goalDraftMode ?? null;
  const liveMode = (props: ChatComposerProps) =>
    (props.draftSource ? props.draftSource.read().goalDraftMode : props.goalDraftMode) ?? null;
  const [pending, setPending] = state.goalPending;
  // Updaters read staged writes too, so a second action cannot beat the render flush.
  const pendingNow = (current: ChatGoalDraftMode | null) =>
    current !== null && setPending((value) => value) === current;
  const replaceDraft = (draft: string) => {
    commitComposerDraft(readProps(), draft);
    const textarea = state.composerTextarea;
    if (textarea) {
      textarea.value = draft;
      adjustTextareaHeight(textarea);
    }
  };
  const focus = () => queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
  const clearMode = (current: ChatGoalDraftMode) => {
    readProps().onGoalDraftModeChange?.(null);
    // Editing borrows the composer; leaving it restores the conversation draft.
    if (current.action === "edit") {
      replaceDraft(current.previousDraft);
    }
  };
  const cancel = () => {
    const current = liveMode(readProps());
    if (!current || pendingNow(current)) {
      return;
    }
    clearMode(current);
    focus();
  };
  const begin = (goal?: SessionGoal) => {
    const props = readProps();
    if (!props.onGoalSubmit || !props.onGoalDraftModeChange || pendingNow(liveMode(props))) {
      return false;
    }
    const previousDraft = state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft;
    props.onGoalDraftModeChange({
      ...(props.currentSessionId ? { sessionId: props.currentSessionId } : {}),
      ...(goal ? { action: "edit", goalId: goal.id, previousDraft } : { action: "start" }),
    });
    state.slashMenu.reset();
    state.skillMenu.reset();
    replaceDraft(goal?.objective ?? "");
    focus();
    return true;
  };
  const activateDraft = (draft: string, submitting = false) => {
    const props = readProps();
    if (liveMode(props) || !props.connected || !props.canSend || !props.onGoalSubmit) {
      return false;
    }
    const match = /^\s*\/goal(?:\s+(start|set|create))?\s*$/iu.exec(draft);
    // A separator commits the action word; prefixes remain ordinary objectives.
    if (!match || (!submitting && (!match[1] || !/\s$/u.test(draft)))) {
      return false;
    }
    return begin();
  };
  return {
    get active() {
      return mode() !== null;
    },
    get pending() {
      return Boolean(mode() && pending() === mode());
    },
    get submissionLabel() {
      const current = mode();
      return current
        ? t(current.action === "edit" ? "chat.goals.save" : "chat.goals.start")
        : undefined;
    },
    get mode() {
      return mode();
    },
    begin,
    activateDraft,
    activateCommand: (command: SlashCommandDef, inline: boolean) => {
      if (command.key !== "goal" || command.source !== "native" || inline) {
        return false;
      }
      return begin();
    },
    cancel,
    async submit(submissionAction?: Event) {
      const props = readProps();
      const current = liveMode(props);
      const key = composerDraftKey(props);
      const objective = state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft;
      if (!current || !props.onGoalSubmit || !objective.trim()) {
        return;
      }
      let admitted = false;
      setPending((previous) => {
        if (previous === current) {
          return previous;
        }
        admitted = true;
        return current;
      });
      if (!admitted) {
        return;
      }
      replaceDraft(objective);
      try {
        const submitted = await props.onGoalSubmit(
          {
            ...(current.sessionId ? { sessionId: current.sessionId } : {}),
            ...(current.action === "start"
              ? { action: "start", objective }
              : { action: "edit", goalId: current.goalId, objective }),
          },
          submissionAction,
        );
        const live = readProps();
        if (
          submitted &&
          state.composerDraftScope?.key === key &&
          composerDraftKey(live) === key &&
          liveMode(live) === current
        ) {
          clearMode(current);
        }
      } finally {
        setPending((previous) => (previous === current ? null : previous));
      }
    },
  };
}

export type GoalComposer = ReturnType<typeof createGoalComposer>;

export function GoalComposerMode(props: { composer: GoalComposer }) {
  return (
    <Show when={props.composer.mode}>
      {(mode) => (
        <div
          class="agent-chat__goal-mode composer-context-strip"
          role="group"
          aria-label={t("chat.goals.composerMode")}
        >
          <span class="agent-chat__goal-mode-label composer-context-strip__label">
            <span class="composer-context-strip__icon">{<Icon name="flag" />}</span>
            <span class="composer-context-strip__label-text">
              {t(mode().action === "edit" ? "chat.goals.edit" : "chat.goals.composerMode")}
            </span>
          </span>
          <span class="agent-chat__goal-mode-hint composer-context-strip__text">
            {t(mode().action === "edit" ? "chat.goals.editHint" : "chat.goals.startHint")}
          </span>
          <button
            type="button"
            class="composer-context-strip__dismiss"
            aria-label={t("chat.goals.cancel")}
            disabled={props.composer.pending}
            onClick={() => props.composer.cancel()}
          >
            {<Icon name="x" />}
          </button>
        </div>
      )}
    </Show>
  );
}
