import type { SessionGoal } from "../../../api/types.ts";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import type { ChatGoalDraftMode } from "../../../lib/chat/chat-types.ts";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import { focusComposerInput, selectComposerInput } from "../../../lib/composer-input.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { isChatGoalCreationDraft } from "../chat-goals.ts";
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
  const focus = () =>
    queueMicrotask(() => focusComposerInput(state.composerTextarea, { preventScroll: true }));
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
  const begin = (goal?: SessionGoal, commandObjective?: string) => {
    const props = readProps();
    if (!props.onGoalSubmit || !props.onGoalDraftModeChange || pendingNow(liveMode(props))) {
      return false;
    }
    const previousDraft = state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft;
    props.onGoalDraftModeChange({
      ...(props.currentSessionId ? { sessionId: props.currentSessionId } : {}),
      ...(goal
        ? { action: "edit", goalId: goal.id, previousDraft }
        : { action: "start", ...(commandObjective !== undefined ? { fromCommand: true } : {}) }),
    });
    state.slashMenu.reset();
    state.skillMenu.reset();
    const textarea = state.composerTextarea;
    const selection =
      commandObjective !== undefined && textarea
        ? {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
            direction: textarea.selectionDirection,
          }
        : null;
    replaceDraft(goal?.objective ?? commandObjective ?? "");
    if (selection && textarea && commandObjective !== undefined) {
      const consumed = previousDraft.length - commandObjective.length;
      selectComposerInput(
        textarea,
        Math.max(0, selection.start - consumed),
        Math.max(0, selection.end - consumed),
        selection.direction,
      );
    }
    focus();
    return true;
  };
  const restoreCommand = () => {
    const props = readProps();
    const current = liveMode(props);
    if (
      current?.action !== "start" ||
      !current.fromCommand ||
      !props.onGoalDraftModeChange ||
      pendingNow(current)
    ) {
      return false;
    }
    props.onGoalDraftModeChange(null);
    replaceDraft("/goal ");
    selectComposerInput(state.composerTextarea, 6, 6);
    focus();
    return true;
  };
  const activateDraft = (draft: string, submitting = false) => {
    const props = readProps();
    const current = liveMode(props);
    if (pendingNow(current)) {
      return false;
    }
    if (current) {
      // Initial empty starters stay open: only a later native edit reaches this branch.
      if (!submitting && draft.length === 0) {
        restoreCommand();
      }
      return false;
    }
    if (!props.connected || !props.canSend || !props.onGoalSubmit || !props.onGoalDraftModeChange) {
      return false;
    }
    if (isChatGoalCreationDraft(draft)) {
      const objective = draft.replace(/^\s*\/goal\s+(?:(?:start|set|create)\s)?/iu, "");
      const activated = begin(undefined, objective);
      // A populated command entered with Send submits on that same action.
      return activated && !objective.trim();
    }
    return submitting && /^\s*\/goal(?:\s+(?:start|set|create))?\s*$/iu.test(draft)
      ? begin(undefined, "")
      : false;
  };
  return {
    get active() {
      return liveMode(readProps()) !== null;
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
    activateCommand: (command: SlashCommandDef, inline: boolean, objective?: string) => {
      if (command.key !== "goal" || command.source !== "native" || inline) {
        return false;
      }
      return begin(undefined, objective);
    },
    cancel,
    restoreCommand,
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
