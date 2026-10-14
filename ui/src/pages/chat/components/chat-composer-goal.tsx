import type { JSX } from "@solidjs/web";
import { For, Show, createEffect, untrack } from "solid-js";
import type { SessionGoal } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import type { ChatGoalAction, ChatGoalRecovery } from "../../../lib/chat/chat-types.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  formatGoalDetail,
  formatGoalElapsed,
  formatGoalStatusLabel,
  formatGoalUsage,
  goalElapsedMs,
} from "../../../lib/session-goal.ts";
import { composerScrollStateRef } from "./chat-composer-menu.tsx";

registerEnglishCatalog(registerChatGoalsEnglish);

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
      const timer = setInterval(sync, 1000);
      return () => clearInterval(timer);
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
  resumeRecovery?: ChatGoalRecovery;
  connected?: boolean;
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
  const canResume = () => props.goal.status !== "active";
  const pauseReason = () =>
    canResume() && !props.expanded && !props.resumeRecovery ? props.goal.lastStatusNote : undefined;
  const statusLabel = () =>
    props.resumeRecovery
      ? t(props.resumeRecovery.pending ? "chat.goals.resuming" : "chat.goals.resumeUnconfirmed")
      : formatGoalStatusLabel(props.goal.status);
  const visibleAction = (action: (typeof goalActions)[number]) =>
    !props.resumeRecovery &&
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
      class={`agent-chat__goal agent-chat__goal--${props.resumeRecovery ? "resuming" : props.goal.status}`}
      data-expanded={String(props.expanded)}
      role="group"
      aria-label={
        props.resumeRecovery
          ? `${statusLabel()}: ${props.goal.objective}`
          : formatGoalDetail(props.goal)
      }
      aria-busy={props.resumeRecovery?.pending ? "true" : "false"}
    >
      <div class="agent-chat__goal-row">
        <span class="agent-chat__goal-icon" aria-hidden="true">
          {props.resumeRecovery?.pending ? (
            <span class="session-run-spinner" />
          ) : props.goal.status === "active" ? (
            <GoalIcon />
          ) : (
            <Icon name={goalStatusIcons[props.goal.status]} />
          )}
        </span>
        <span class="agent-chat__goal-copy">
          <openclaw-tooltip prop:content={pauseReason() ?? ""} disabled={!pauseReason()}>
            <span
              class="agent-chat__goal-label"
              role="status"
              tabindex={pauseReason() ? "0" : undefined}
            >
              {statusLabel()}
            </span>
          </openclaw-tooltip>
          <span class="agent-chat__goal-objective">{props.goal.objective}</span>
        </span>
        <span class="agent-chat__goal-elapsed" ref={createGoalElapsedRef(() => props.goal)} />
        <span class="agent-chat__goal-actions">
          <span class="agent-chat__goal-command-actions">
            <Show when={props.resumeRecovery && !props.resumeRecovery.pending}>
              <button
                class="agent-chat__goal-action agent-chat__goal-resume"
                type="button"
                disabled={!props.connected}
                onClick={() => void props.resumeRecovery?.onCheck()}
              >
                <Icon name="play" />
                <span class="agent-chat__goal-action-label">{t("chat.goals.retryResume")}</span>
              </button>
            </Show>
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
            ref={composerScrollStateRef(() => props.goal.objective)}
            textContent={props.goal.objective}
          />
          {props.goal.lastStatusNote && !props.resumeRecovery ? (
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
        resumeRecovery={props.resumeRecovery}
        connected={props.connected}
        onGoalAction={props.onGoalAction}
        onGoalEdit={props.onGoalEdit}
        onExpandedChange={props.onExpandedChange}
      />
    </Show>
  );
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
