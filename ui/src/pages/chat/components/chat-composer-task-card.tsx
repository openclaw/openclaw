import { createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ComposerTasks } from "../../../lib/chat/composer-tasks.runtime.ts";
import { t } from "../../../lib/reactive/i18n.ts";

function elapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const STEP_GLYPH = { running: "•", done: "✓", failed: "✗" } as const;

/**
 * The pane's composer task, in one card above the input that keeps its height from working to
 * proposal or failure, so the composer never moves. The textarea stays the only editing owner.
 */
export function ComposerTaskCardView(props: {
  tasks: ComposerTasks;
  draft: string;
  canCompose: boolean;
  keyHints: boolean;
  textarea: () => HTMLTextAreaElement | null;
}) {
  const [now, setNow] = createSignal(Date.now());
  const working = createMemo(() => props.tasks.card?.kind === "working");
  onSettled(() => {
    // The working clock is the only timer; it ticks while a task works.
    const timer = setInterval(() => working() && setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const workingCard = () => {
    const card = props.tasks.card;
    return card?.kind === "working" ? card : undefined;
  };
  const proposalCard = () => {
    const card = props.tasks.card;
    return card?.kind === "proposal" ? card : undefined;
  };
  const failedCard = () => {
    const card = props.tasks.card;
    return card?.kind === "failed" ? card : undefined;
  };
  return (
    <Switch
      fallback={
        <Show when={props.tasks.accepted}>
          {(accepted) => (
            <div
              class="agent-chat__composer-status agent-chat__composer-task--receipt"
              role="status"
            >
              <div class="agent-chat__composer-status-band">
                <span class="agent-chat__composer-status-icon" aria-hidden="true">
                  <Icon name="check" />
                </span>
                <span class="agent-chat__composer-status-text">
                  {t("chat.composer.proposal.accepted")}
                </span>
                <span class="agent-chat__composer-task-meta muted">
                  {accepted().title} · {t("chat.composer.proposal.notSent")}
                </span>
                <button
                  type="button"
                  class="btn btn--sm btn--ghost"
                  disabled={props.textarea()?.readOnly === true}
                  onClick={() => props.tasks.undo(props.textarea())}
                >
                  <Icon name="rotateCcw" />
                  {t("chat.composer.proposal.undo")}
                </button>
              </div>
            </div>
          )}
        </Show>
      }
    >
      <Match when={workingCard()}>
        {(task) => (
          <div class="agent-chat__composer-status agent-chat__composer-task" data-state="working">
            <div class="agent-chat__composer-status-band">
              <span class="agent-chat__composer-status-icon" aria-hidden="true">
                <Icon name="pencilSparkles" />
              </span>
              <span class="agent-chat__composer-status-text text-shimmer">{task().title}</span>
              <span class="agent-chat__composer-task-meta muted">
                {elapsed(task().startedAt, now())}
              </span>
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                onClick={() => props.tasks.cancel()}
              >
                {t("chat.composer.task.cancel")}
              </button>
            </div>
            <div class="agent-chat__composer-task-steps mono muted">
              <span>{task().summary ?? t("chat.composer.task.starting")}</span>
              <For each={task().steps.toReversed()}>
                {(step) => (
                  <span data-state={step.state} title={step.label}>
                    {STEP_GLYPH[step.state]} {step.label}
                  </span>
                )}
              </For>
            </div>
          </div>
        )}
      </Match>
      <Match when={proposalCard()}>
        {(proposal) => (
          <div
            class="agent-chat__composer-status agent-chat__composer-task"
            data-state="proposal"
            role="region"
            aria-label={proposal().title}
          >
            <div class="agent-chat__composer-status-band">
              <span class="agent-chat__composer-status-icon" aria-hidden="true">
                <Icon name="pencilSparkles" />
              </span>
              <span class="agent-chat__composer-status-text">{proposal().title}</span>
              <span class="agent-chat__composer-task-meta muted">
                {props.draft.trim()
                  ? t("chat.composer.proposal.replacesDraft")
                  : t("chat.composer.proposal.notSent")}
              </span>
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                onClick={() => props.tasks.dismiss()}
              >
                {t("chat.composer.proposal.dismiss")}
                <Show when={props.keyHints}>
                  <kbd class="agent-chat__composer-prediction-hint">
                    {t("chat.composer.proposal.dismissKey")}
                  </kbd>
                </Show>
              </button>
              <button
                type="button"
                class="btn btn--sm primary"
                disabled={!props.canCompose || props.textarea()?.readOnly === true}
                onClick={() => props.tasks.accept(props.textarea())}
              >
                {t("chat.composer.proposal.use")}
                <Show when={props.keyHints}>
                  <kbd class="agent-chat__composer-prediction-hint">
                    {t("chat.composer.proposal.useKey")}
                  </kbd>
                </Show>
              </button>
            </div>
            <p class="chat-queue__text" title={proposal().text}>
              {proposal().text}
            </p>
          </div>
        )}
      </Match>
      <Match when={failedCard()}>
        {(failure) => (
          <div
            class="agent-chat__composer-status agent-chat__composer-task"
            data-state="failed"
            data-tone="danger"
            role="alert"
          >
            <div class="agent-chat__composer-status-band">
              <span class="agent-chat__composer-status-icon" aria-hidden="true">
                <Icon name="alertTriangle" />
              </span>
              <span class="agent-chat__composer-status-text">
                {t("chat.composer.task.failedTitle")}
              </span>
              <span class="agent-chat__composer-task-meta muted">
                {failure().title} · {t("chat.composer.task.draftUnchanged")}
              </span>
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                onClick={() => props.tasks.dismiss()}
              >
                {t("chat.composer.proposal.dismiss")}
              </button>
              <Show when={failure().retry}>
                <button type="button" class="btn btn--sm" onClick={() => props.tasks.retry()}>
                  <Icon name="rotateCcw" />
                  {t("chat.composer.task.retry")}
                </button>
              </Show>
            </div>
            <p class="chat-queue__text muted" title={failure().message}>
              {failure().message}
            </p>
          </div>
        )}
      </Match>
    </Switch>
  );
}
