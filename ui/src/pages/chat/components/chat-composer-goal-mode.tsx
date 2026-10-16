import { createMemo, createStore, onCleanup, Show } from "solid-js";
import "../../../styles/chat/composer-context-strip.css";
import type { SessionGoal } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import type { ChatGoalDraftMode } from "../../../lib/chat/chat-types.ts";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { resetSkillMenuState } from "./chat-composer-skill-menu.tsx";
import { resetSlashMenuState } from "./chat-composer-slash-menu.tsx";
import { commitComposerDraft, composerDraftKey } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

registerEnglishCatalog(registerChatGoalsEnglish);

type GoalMode = { value: ChatGoalDraftMode; key: string; token: symbol };

function sameGoalMode(left: ChatGoalDraftMode | null | undefined, right: ChatGoalDraftMode) {
  return (
    left?.action === right.action &&
    left.sessionId === right.sessionId &&
    (left.action !== "edit" ||
      (right.action === "edit" &&
        left.goalId === right.goalId &&
        left.previousDraft === right.previousDraft))
  );
}

export function createGoalComposer(readProps: () => ChatComposerProps, state: ChatComposerState) {
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const mode = createMemo<GoalMode | null>((previous) => {
    const props = readProps();
    const value = props.goalDraftMode;
    if (!value) {
      return null;
    }
    const key = composerDraftKey(props);
    return previous?.key === key && sameGoalMode(previous.value, value)
      ? previous
      : { value, key, token: Symbol("goal-mode") };
  });
  const [request, setRequest] = createStore<{ token: symbol | null }>({ token: null });
  const pendingNow = (current: GoalMode | null) => {
    let pending = false;
    setRequest((draft) => {
      pending = Boolean(current && draft.token === current.token);
    });
    return pending;
  };
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
    const current = mode();
    if (!current || pendingNow(current)) {
      return;
    }
    clearMode(current.value);
    focus();
  };
  const begin = (goal?: SessionGoal) => {
    const props = readProps();
    if (!props.onGoalSubmit || !props.onGoalDraftModeChange || pendingNow(mode())) {
      return false;
    }
    const previousDraft = state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft;
    props.onGoalDraftModeChange({
      ...(props.currentSessionId ? { sessionId: props.currentSessionId } : {}),
      ...(goal ? { action: "edit", goalId: goal.id, previousDraft } : { action: "start" }),
    });
    resetSlashMenuState(state);
    resetSkillMenuState(state);
    replaceDraft(goal?.objective ?? "");
    focus();
    return true;
  };
  const activateDraft = (draft: string, submitting = false) => {
    const props = readProps();
    if (mode() || !props.connected || !props.canSend || !props.onGoalSubmit) {
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
      return Boolean(mode() && request.token === mode()?.token);
    },
    get submissionLabel() {
      const current = mode();
      return current
        ? t(current.value.action === "edit" ? "chat.goals.save" : "chat.goals.start")
        : undefined;
    },
    get mode() {
      return mode()?.value ?? null;
    },
    begin,
    activateDraft,
    activateCommand: (command: SlashCommandDef) => {
      if (
        command.key !== "goal" ||
        command.source !== "native" ||
        state.slashMenuCompletion?.inline
      ) {
        return false;
      }
      return begin();
    },
    cancel,
    async submit(submissionAction?: Event) {
      const current = mode();
      const props = readProps();
      const objective = state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft;
      if (!current || !props.onGoalSubmit || !objective.trim()) {
        return;
      }
      let admitted = false;
      // Store draft reads include earlier same-turn admissions, before rendering commits.
      setRequest((draft) => {
        if (draft.token === current.token) {
          return;
        }
        draft.token = current.token;
        admitted = true;
      });
      if (!admitted) {
        return;
      }
      replaceDraft(objective);
      try {
        const active = current.value;
        const submitted = await props.onGoalSubmit(
          {
            ...(active.sessionId ? { sessionId: active.sessionId } : {}),
            ...(active.action === "start"
              ? { action: "start", objective }
              : { action: "edit", goalId: active.goalId, objective }),
          },
          submissionAction,
        );
        const live = readProps();
        const liveMode = live.draftSource
          ? live.draftSource.read().goalDraftMode
          : live.goalDraftMode;
        if (
          submitted &&
          mode() === current &&
          state.composerDraftScope?.key === current.key &&
          composerDraftKey(live) === current.key &&
          sameGoalMode(liveMode, active)
        ) {
          clearMode(active);
        }
      } finally {
        if (!disposed) {
          setRequest((draft) => {
            if (draft.token === current.token) {
              draft.token = null;
            }
          });
        }
      }
    },
  };
}

export type GoalComposer = ReturnType<typeof createGoalComposer>;

export function GoalComposerMode(props: { composer: GoalComposer }) {
  return (
    <Show when={props.composer.mode}>
      {(mode) => (
        <>
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
        </>
      )}
    </Show>
  );
}
