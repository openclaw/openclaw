import { html, nothing, svg, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { SessionGoal } from "../../../api/types.ts";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { scrollState } from "../../../components/scroll-state.ts";
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
import type { ChatComposerState } from "./chat-composer-types.ts";

registerChatGoalsEnglish();

const goalElapsedTimers = new Map<HTMLElement, ReturnType<typeof setInterval>>();
const goalIcon = strokeIcon(svg` <path d="M12 13V2l8 4-8 4" />
  <path d="M20.561 10.222a9 9 0 1 1-12.55-5.29" />
  <path d="M8.002 9.997a5 5 0 1 0 8.9 2.02" />`);

const goalStatusIcons: Record<SessionGoal["status"], TemplateResult> = {
  active: goalIcon,
  paused: icons.pause,
  blocked: icons.alertTriangle,
  usage_limited: icons.alertTriangle,
  budget_limited: icons.alertTriangle,
  complete: icons.check,
};

function clearGoalElapsedTimer(el: HTMLElement) {
  const timer = goalElapsedTimers.get(el);
  if (timer !== undefined) {
    clearInterval(timer);
    goalElapsedTimers.delete(el);
  }
}

// Ticks the elapsed span in place so an idle active goal does not force
// full chat re-renders every second.
function createGoalElapsedRef(goal: SessionGoal) {
  let bound: HTMLElement | null = null;
  return (element: Element | undefined) => {
    if (bound) {
      clearGoalElapsedTimer(bound);
      bound = null;
    }
    if (!(element instanceof HTMLElement)) {
      return;
    }
    element.textContent = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
    if (goal.status !== "active") {
      return;
    }
    bound = element;
    const timer = setInterval(() => {
      // Tests and detached renders can drop the pill without a final ref call.
      if (!element.isConnected) {
        clearGoalElapsedTimer(element);
        return;
      }
      element.textContent = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
    }, 1000);
    goalElapsedTimers.set(element, timer);
  };
}

type ChatGoalActions = {
  canAct: boolean;
  onGoalAction?: (goalId: string, action: ChatGoalAction) => void;
  onGoalEdit?: (goal: SessionGoal) => void;
  requestUpdate: () => void;
};

function renderChatGoalActionButton(options: {
  className: string;
  label: string;
  chipLabel: string;
  icon: TemplateResult;
  onClick: () => void;
}): TemplateResult {
  return html`
    <openclaw-tooltip content=${options.label}>
      <button
        class="agent-chat__goal-action ${options.className}"
        type="button"
        aria-label=${options.label}
        @click=${options.onClick}
      >
        ${options.icon}
        <span class="agent-chat__goal-action-label">${options.chipLabel}</span>
      </button>
    </openclaw-tooltip>
  `;
}

export function renderChatGoal(
  state: ChatComposerState,
  goal: SessionGoal | undefined,
  actions: ChatGoalActions,
): TemplateResult | typeof nothing {
  if (!goal) {
    return nothing;
  }
  const elapsed = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
  const usage = formatGoalUsage(goal);
  const expanded = state.goalExpandedId === goal.id;
  const showActions = actions.canAct && Boolean(actions.onGoalAction);
  const canResume =
    goal.status === "paused" ||
    goal.status === "blocked" ||
    goal.status === "usage_limited" ||
    goal.status === "budget_limited";
  const pauseReason = canResume && !expanded ? goal.lastStatusNote : undefined;
  const toggleExpanded = () => {
    state.goalExpandedId = expanded ? null : goal.id;
    actions.requestUpdate();
  };
  return html`
    <div
      class="agent-chat__goal agent-chat__goal--${goal.status}"
      data-expanded=${String(expanded)}
      role="group"
      aria-label=${formatGoalDetail(goal)}
    >
      <div class="agent-chat__goal-row">
        <span class="agent-chat__goal-icon" aria-hidden="true"
          >${goalStatusIcons[goal.status]}</span
        >
        <span class="agent-chat__goal-copy">
          <openclaw-tooltip .content=${pauseReason ?? ""} ?disabled=${!pauseReason}>
            <span class="agent-chat__goal-label" tabindex=${pauseReason ? "0" : nothing}
              >${formatGoalStatusLabel(goal.status)}</span
            >
          </openclaw-tooltip>
          <span class="agent-chat__goal-objective">${goal.objective}</span>
        </span>
        <span class="agent-chat__goal-elapsed" ${ref(createGoalElapsedRef(goal))}></span>
        <span class="agent-chat__goal-actions">
          <span class="agent-chat__goal-command-actions">
            ${
              showActions && actions.onGoalEdit && goal.status !== "complete"
                ? renderChatGoalActionButton({
                    className: "agent-chat__goal-edit",
                    label: t("chat.goals.edit"),
                    chipLabel: t("chat.goals.editChip"),
                    icon: icons.penLine,
                    onClick: () => actions.onGoalEdit?.(goal),
                  })
                : nothing
            }
            ${
              showActions && goal.status === "active"
                ? renderChatGoalActionButton({
                    className: "agent-chat__goal-pause",
                    label: t("chat.goals.pause"),
                    chipLabel: t("chat.goals.pauseChip"),
                    icon: icons.pause,
                    onClick: () => actions.onGoalAction?.(goal.id, "pause"),
                  })
                : nothing
            }
            ${
              showActions && canResume
                ? renderChatGoalActionButton({
                    className: "agent-chat__goal-resume",
                    label: t("chat.goals.resume"),
                    chipLabel: t("chat.goals.resumeChip"),
                    icon: icons.play,
                    onClick: () => actions.onGoalAction?.(goal.id, "resume"),
                  })
                : nothing
            }
            ${
              showActions
                ? renderChatGoalActionButton({
                    className: "agent-chat__goal-clear",
                    label: t("chat.goals.clear"),
                    chipLabel: t("chat.goals.clearChip"),
                    icon: icons.trash,
                    onClick: () => actions.onGoalAction?.(goal.id, "clear"),
                  })
                : nothing
            }
          </span>
          <button
            class="agent-chat__goal-action agent-chat__goal-expand"
            type="button"
            aria-expanded=${expanded ? "true" : "false"}
            aria-label=${t(expanded ? "chat.goals.hideDetails" : "chat.goals.showDetails")}
            @click=${toggleExpanded}
          >
            ${expanded ? icons.chevronDown : icons.chevronRight}
          </button>
        </span>
      </div>
      <div
        class="agent-chat__goal-detail"
        data-expanded=${String(expanded)}
        aria-hidden=${String(!expanded)}
        ?inert=${!expanded}
      >
        <div class="agent-chat__goal-detail-content">
          <div
            class="agent-chat__goal-detail-objective"
            ${scrollState()}
            .textContent=${goal.objective}
          ></div>
          ${
            goal.lastStatusNote
              ? html`<div class="agent-chat__goal-detail-note">${goal.lastStatusNote}</div>`
              : nothing
          }
          <div class="agent-chat__goal-detail-meta">
            ${
              usage
                ? html`
                    <span class="agent-chat__goal-detail-usage">${usage}</span>
                    <span class="agent-chat__goal-detail-separator" aria-hidden="true">·</span>
                  `
                : nothing
            }
            <span class="agent-chat__goal-detail-duration">${elapsed}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function clearGoalElapsedTimers(): void {
  for (const timer of goalElapsedTimers.values()) {
    clearInterval(timer);
  }
  goalElapsedTimers.clear();
}

export function renderChatGoalRecovery(
  recovery: ChatGoalRecovery | undefined,
  connected: boolean,
): TemplateResult | typeof nothing {
  if (!recovery) {
    return nothing;
  }
  return html`
    <div class="chat-composer-neighbor-card chat-composer-neighbor-card--warn" role="status">
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
        >${icons.alertTriangle}</span
      >
      <div class="chat-composer-neighbor-card__copy">
        <strong>${t(recovery.pending ? "chat.goals.checking" : "chat.goals.recoveryTitle")}</strong>
        <span
          >${t(
            recovery.retired === "expired"
              ? "chat.goals.recoveryExpired"
              : recovery.retired === "invalid"
                ? "chat.goals.recoveryInvalid"
                : "chat.goals.recoveryHint",
          )}</span
        >
      </div>
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${!connected || recovery.pending}
        @click=${recovery.onCheck}
      >
        ${t(recovery.retired ? "chat.goals.refreshCurrent" : "chat.goals.checkOutcome")}
      </button>
    </div>
  `;
}
