import type { JSX } from "@solidjs/web";
import { For, Show, createEffect, onCleanup, onSettled, untrack } from "solid-js";
import type { SessionGoal } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../i18n/index.ts";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import type { ChatGoalAction, ChatGoalRecovery } from "../../../lib/chat/chat-types.ts";
import {
  formatGoalDetail,
  formatGoalElapsed,
  formatGoalStatusLabel,
  formatGoalUsage,
  goalElapsedMs,
} from "../../../lib/session-goal.ts";

registerChatGoalsEnglish();

const goalElapsedTimers = new Map<HTMLElement, ReturnType<typeof setInterval>>();
function GoalIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 13V2l8 4-8 4" />
      <path d="M20.561 10.222a9 9 0 1 1-12.55-5.29" />
      <path d="M8.002 9.997a5 5 0 1 0 8.9 2.02" />
    </svg>
  );
}

const goalStatusIcons = {
  paused: "pause",
  blocked: "alertTriangle",
  usage_limited: "alertTriangle",
  budget_limited: "alertTriangle",
  complete: "check",
} as const;

function createGoalScrollRef(objective: () => string) {
  let element: HTMLElement | undefined;
  const sync = () => {
    if (!element?.isConnected) {
      return;
    }
    const scrollable = element.scrollHeight > element.clientHeight + 1;
    element.dataset.scrollable = String(scrollable);
    element.dataset.atStart = String(!scrollable || element.scrollTop <= 1);
    element.dataset.atEnd = String(
      !scrollable || element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    );
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
  createEffect(objective, sync);
  onSettled(() => {
    if (element) {
      observer?.observe(element);
    }
    sync();
  });
  onCleanup(() => {
    observer?.disconnect();
    element?.removeEventListener("scroll", sync);
  });
  return (next: HTMLElement) => {
    element = next;
    element.addEventListener("scroll", sync);
  };
}

function clearGoalElapsedTimer(element: HTMLElement) {
  const timer = goalElapsedTimers.get(element);
  if (timer !== undefined) {
    clearInterval(timer);
    goalElapsedTimers.delete(element);
  }
}

// Keep the one-second clock local to its span; it must not invalidate the composer.
function createGoalElapsedRef(goal: () => SessionGoal) {
  let element: HTMLElement | undefined;
  const sync = () => {
    if (element) {
      element.textContent = formatGoalElapsed(goalElapsedMs(untrack(goal), Date.now()));
    }
  };
  createEffect(
    () => ({ active: goal().status === "active", elapsed: goalElapsedMs(goal(), Date.now()) }),
    (clock) => {
      if (!element) {
        return undefined;
      }
      const bound = element;
      bound.textContent = formatGoalElapsed(clock.elapsed);
      if (!clock.active) {
        return undefined;
      }
      goalElapsedTimers.set(bound, setInterval(sync, 1000));
      return () => clearGoalElapsedTimer(bound);
    },
  );
  return (next: HTMLElement) => {
    element = next;
    sync();
  };
}

type ChatGoalProps = {
  goal?: SessionGoal;
  expanded: boolean;
  canAct: boolean;
  onGoalAction?: (goalId: string, action: ChatGoalAction) => void;
  onGoalEdit?: (goal: SessionGoal) => void;
  onExpandedChange: (expanded: boolean) => void;
};

const goalActions = ["edit", "pause", "resume", "clear"] as const;
const goalActionIcons = {
  edit: "penLine",
  pause: "pause",
  resume: "play",
  clear: "trash",
} as const;

function GoalCard(props: Omit<ChatGoalProps, "goal"> & { goal: SessionGoal }) {
  const canResume = () =>
    ["paused", "blocked", "usage_limited", "budget_limited"].includes(props.goal.status);
  const pauseReason = () =>
    canResume() && !props.expanded ? props.goal.lastStatusNote : undefined;
  const visibleAction = (action: (typeof goalActions)[number]) =>
    props.canAct &&
    Boolean(props.onGoalAction) &&
    (action === "edit"
      ? Boolean(props.onGoalEdit) && props.goal.status !== "complete"
      : action === "pause"
        ? props.goal.status === "active"
        : action === "resume"
          ? canResume()
          : true);
  return (
    <div
      class={`agent-chat__goal agent-chat__goal--${props.goal.status}`}
      data-expanded={String(props.expanded)}
      role="group"
      aria-label={formatGoalDetail(props.goal)}
    >
      <div class="agent-chat__goal-row">
        <span class="agent-chat__goal-icon" aria-hidden="true">
          {props.goal.status === "active" ? (
            <GoalIcon />
          ) : (
            <Icon name={goalStatusIcons[props.goal.status]} />
          )}
        </span>
        <span class="agent-chat__goal-copy">
          <openclaw-tooltip prop:content={pauseReason() ?? ""} disabled={!pauseReason()}>
            <span class="agent-chat__goal-label" tabindex={pauseReason() ? "0" : undefined}>
              {formatGoalStatusLabel(props.goal.status)}
            </span>
          </openclaw-tooltip>
          <span class="agent-chat__goal-objective">{props.goal.objective}</span>
        </span>
        <span class="agent-chat__goal-elapsed" ref={createGoalElapsedRef(() => props.goal)} />
        <span class="agent-chat__goal-actions">
          <span class="agent-chat__goal-command-actions">
            <For each={goalActions}>
              {(action) => (
                <>
                  {visibleAction(action) ? (
                    <openclaw-tooltip content={t(`chat.goals.${action}`)}>
                      <button
                        class={`agent-chat__goal-action agent-chat__goal-${action}`}
                        type="button"
                        aria-label={t(`chat.goals.${action}`)}
                        onClick={() => {
                          if (action === "edit") {
                            props.onGoalEdit?.(props.goal);
                          } else {
                            props.onGoalAction?.(props.goal.id, action);
                          }
                        }}
                      >
                        <Icon name={goalActionIcons[action]} />
                        <span class="agent-chat__goal-action-label">
                          {t(`chat.goals.${action}Chip`)}
                        </span>
                      </button>
                    </openclaw-tooltip>
                  ) : null}
                </>
              )}
            </For>
          </span>
          <button
            class="agent-chat__goal-action agent-chat__goal-expand"
            type="button"
            aria-expanded={props.expanded ? "true" : "false"}
            aria-label={t(props.expanded ? "chat.goals.hideDetails" : "chat.goals.showDetails")}
            onClick={() => props.onExpandedChange(!props.expanded)}
          >
            <Icon name={props.expanded ? "chevronDown" : "chevronRight"} />
          </button>
        </span>
      </div>
      <div
        class="agent-chat__goal-detail"
        data-expanded={String(props.expanded)}
        aria-hidden={props.expanded ? "false" : "true"}
        inert={!props.expanded}
      >
        <div class="agent-chat__goal-detail-content">
          <div
            class="agent-chat__goal-detail-objective"
            ref={createGoalScrollRef(() => props.goal.objective)}
            textContent={props.goal.objective}
          />
          {props.goal.lastStatusNote ? (
            <div class="agent-chat__goal-detail-note">{props.goal.lastStatusNote}</div>
          ) : null}
          <div class="agent-chat__goal-detail-meta">
            {formatGoalUsage(props.goal) ? (
              <>
                <span class="agent-chat__goal-detail-usage">{formatGoalUsage(props.goal)}</span>
                <span class="agent-chat__goal-detail-separator" aria-hidden="true">
                  ·
                </span>
              </>
            ) : null}
            <span class="agent-chat__goal-detail-duration">
              {formatGoalElapsed(goalElapsedMs(props.goal, Date.now()))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatGoal(props: ChatGoalProps) {
  return (
    <Show when={props.goal !== undefined}>
      <GoalCard
        goal={props.goal!}
        expanded={props.expanded}
        canAct={props.canAct}
        onGoalAction={props.onGoalAction}
        onGoalEdit={props.onGoalEdit}
        onExpandedChange={props.onExpandedChange}
      />
    </Show>
  );
}

export function clearGoalElapsedTimers(): void {
  for (const timer of goalElapsedTimers.values()) {
    clearInterval(timer);
  }
  goalElapsedTimers.clear();
}

export function renderChatGoalRecoverySolid(
  recovery: ChatGoalRecovery | undefined,
  connected: boolean,
): JSX.Element {
  if (!recovery) {
    return null;
  }
  return (
    <div class="chat-composer-neighbor-card chat-composer-neighbor-card--warn" role="status">
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
        <Icon name="alertTriangle" />
      </span>
      <div class="chat-composer-neighbor-card__copy">
        <strong>{t(recovery.pending ? "chat.goals.checking" : "chat.goals.recoveryTitle")}</strong>
        <span>
          {t(
            recovery.retired === "expired"
              ? "chat.goals.recoveryExpired"
              : recovery.retired === "invalid"
                ? "chat.goals.recoveryInvalid"
                : "chat.goals.recoveryHint",
          )}
        </span>
      </div>
      <button
        class="btn btn--sm"
        type="button"
        disabled={!connected || recovery.pending}
        onClick={() => void recovery.onCheck()}
      >
        {t(recovery.retired ? "chat.goals.refreshCurrent" : "chat.goals.checkOutcome")}
      </button>
    </div>
  );
}
