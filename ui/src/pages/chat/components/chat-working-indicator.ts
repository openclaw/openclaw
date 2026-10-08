import { html, nothing } from "lit";
import type { ThemeMascot } from "../../../../../packages/gateway-protocol/src/theme.ts";
import "../../../components/elapsed-time.ts";
import "../../../components/working-phrase.ts";
import { icons } from "../../../components/icons.ts";
import { currentThemeBranding } from "../../../components/neutral-mark.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatDurationLong } from "../../../lib/format-duration.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import type { TurnRecap } from "../chat-progress.ts";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";

// 0 is valid; only null/undefined means "unknown".
function outputTokensLabel(outputTokens: number): string {
  return outputTokens === 1
    ? t("chat.turnRecap.tokensOne")
    : t("chat.turnRecap.tokens", { count: formatCompactTokenCount(outputTokens) });
}

export function renderChatWorkingIndicator(
  part: Extract<ChatItem, { kind: "reading-indicator" }>,
  options: {
    mascot?: ThemeMascot;
    workingPhrases?: readonly string[];
    waitingApproval?: boolean;
    waitingSubagents?: ChatSubagentWait;
    /** Unfinished subagents to mention while the session itself is still working. */
    runningSubagents?: number;
    /** Shows one subagent; without it a waited-on subagent's name is plain text. */
    onOpenSubagent?: (key: string) => void;
    /** Shows the session's subagents; without it their count is plain text. */
    onOpenSubagents?: () => void;
    startupLabel?: string;
    outputTokens?: number | null;
    presentation?: "standalone" | "continuation";
  } = {},
) {
  const waitingApproval = options.waitingApproval === true;
  const waitingSubagents = options.waitingSubagents;
  // The wait already says who is left. Beside the session's own work a count is enough.
  const runningSubagents = waitingSubagents ? 0 : (options.runningSubagents ?? 0);
  const child = waitingSubagents?.child;
  // Child sessions that are not subagents get a count and nothing else.
  const waitingSessions =
    waitingSubagents?.runningCount === 0 ? (waitingSubagents.sessionCount ?? 0) : 0;
  const neutral = (options.mascot ?? currentThemeBranding().mascot) === "none";
  const continuation = options.presentation === "continuation";
  // Without loaded child rows the pane only knows that some are still running.
  const statusLabel = waitingSubagents
    ? waitingSubagents.runningCount > 1
      ? t("chat.waitingOnSubagentsCount", { count: String(waitingSubagents.runningCount) })
      : waitingSessions > 1
        ? t("chat.waitingOnSessionsCount", { count: String(waitingSessions) })
        : waitingSessions === 1
          ? t("chat.waitingOnSession")
          : t("chat.waitingOnSubagents")
    : waitingApproval
      ? t("chat.waitingForApproval")
      : options.startupLabel || t("common.working");
  // The name stands in for the count once one child is left. The translated
  // sentence decides where it goes; only that placeholder becomes the control,
  // and a translation without the placeholder still gets the name at its end.
  const [beforeChild = "", ...afterChild] = child
    ? t("chat.waitingOnSubagent").split("{name}")
    : [];
  const sentencePart = (words: string) =>
    words.trim() ? html`<span>${words.trim()}</span>` : nothing;
  const childName = !child
    ? nothing
    : options.onOpenSubagent
      ? html`<button
          class="chat-working-indicator__child"
          type="button"
          title=${child.label}
          @click=${() => options.onOpenSubagent?.(child.key)}
        >
          ${child.label}
        </button>`
      : html`<span class="chat-working-indicator__child" title=${child.label}
          >${child.label}</span
        >`;
  // With several left the whole sentence is the control: where a translation
  // puts the count, and what it puts beside it, differs too much to cut it out.
  const waitingOnCount =
    !child && (waitingSubagents?.runningCount ?? 0) > 1 && options.onOpenSubagents !== undefined;
  const runningLabel =
    runningSubagents === 1
      ? t("chat.subagentsRunningOne")
      : t("chat.subagentsRunning", { count: String(runningSubagents) });
  const working = !waitingSubagents && !waitingApproval && !options.startupLabel;
  // Providers report exact usage at response boundaries, not per text delta.
  // Keep the latest count visible while the run continues through tools.
  const outputTokens = waitingSubagents ? null : options.outputTokens;
  // A wait counts from the handoff, which loaded history cannot always place.
  const startedAt = waitingSubagents ? waitingSubagents.startedAt : part.startedAt;
  // The animated claw stays decorative; the text status exposes progress without
  // announcing every elapsed-time tick to screen readers.
  return html`
    <div
      class="chat-working-indicator ${continuation ? "chat-working-indicator--continuation" : ""} ${waitingSubagents ? "chat-working-indicator--subagents" : ""}"
      role="status"
      aria-live="off"
    >
      ${
        continuation
          ? nothing
          : html`
              <div
                class="chat-bubble chat-reading-indicator ${
                  neutral
                    ? "chat-reading-indicator--neutral"
                    : selectWorkingClawSurprise(part.key, {
                        eligible: !waitingApproval && !waitingSubagents,
                      })
                }"
                aria-hidden="true"
              >
                ${neutral ? html`<span></span><span></span><span></span>` : icons.claw}
              </div>
            `
      }
      <span class="chat-working-indicator__status">
        ${
          child
            ? html`${sentencePart(beforeChild)}${childName}${sentencePart(afterChild.join(""))}`
            : waitingOnCount
              ? html`<button
                  class="chat-working-indicator__subagents"
                  type="button"
                  @click=${() => options.onOpenSubagents?.()}
                >
                  ${statusLabel}
                </button>`
              : html`<span class=${working && !continuation ? "sr-only" : ""}>${statusLabel}</span>`
        }
        ${
          waitingApproval || startedAt === null
            ? nothing
            : html`
                <openclaw-elapsed-time
                  class="chat-working-indicator__elapsed"
                  .startMs=${startedAt}
                ></openclaw-elapsed-time>
              `
        }
        ${
          outputTokens !== null && outputTokens !== undefined
            ? html`
                <span aria-hidden="true">·</span>
                <span class="chat-working-indicator__tokens"
                  >${outputTokensLabel(outputTokens)}</span
                >
              `
            : working
              ? html`
                  <openclaw-working-phrase
                    aria-hidden="true"
                    .startMs=${part.startedAt}
                    .seed=${part.key}
                    .phrases=${options.workingPhrases}
                  ></openclaw-working-phrase>
                `
              : nothing
        }
        ${
          runningSubagents > 0
            ? html`
                <span aria-hidden="true">·</span>
                ${
                  options.onOpenSubagents
                    ? html`<button
                        class="chat-working-indicator__subagents"
                        type="button"
                        @click=${() => options.onOpenSubagents?.()}
                      >
                        ${runningLabel}
                      </button>`
                    : html`<span class="chat-working-indicator__subagents">${runningLabel}</span>`
                }
              `
            : nothing
        }
      </span>
    </div>
  `;
}

/** Post-turn recap row: once the run settles, the parked claw reports how
 * long the turn took and its latest known output usage. Sticky until the
 * next run replaces it. */
export function renderTurnRecapRow(
  recap: TurnRecap,
  options: { presentation?: "standalone" | "continuation" } = {},
) {
  const continuation = options.presentation === "continuation";
  // Sub-second turns still read as one second; terminal recaps favor full words.
  const duration =
    formatDurationLong(Math.max(1, Math.round(recap.runtimeMs / 1_000)) * 1_000) ?? "";
  const tokens =
    typeof recap.outputTokens === "number" ? outputTokensLabel(recap.outputTokens) : null;
  return html`
    <div
      class="chat-turn-recap ${continuation ? "chat-turn-recap--continuation" : ""}"
      role="status"
    >
      ${
        continuation
          ? nothing
          : html`<span class="chat-turn-recap__claw" aria-hidden="true"
              >${currentThemeBranding().mascot === "none" ? icons.mark : icons.claw}</span
            >`
      }
      <span>${t("chat.turnRecap.doneIn", { duration })}</span>
      ${
        tokens === null
          ? nothing
          : html`
              <span class="chat-turn-recap__sep" aria-hidden="true">·</span>
              <span>${tokens}</span>
            `
      }
    </div>
  `;
}
