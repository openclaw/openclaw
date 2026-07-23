import { html, nothing } from "lit";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/working-phrase.ts";
import { i18n, t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import type { TurnRecap } from "../chat-progress.ts";
import type { ChatRunStartupPhase } from "../chat-run-startup.ts";

// One salt per page load keeps each run stable while varying the animation between visits.
// The default stance just claws in place; the busier stances stay rare on purpose.
const STANCE_SALT = Math.trunc(Math.random() * 0xffffffff);
const STANCES: Array<[stance: string, weight: number]> = [
  ["", 63],
  ["chat-reading-indicator--southpaw", 19],
  ["chat-reading-indicator--flurry", 5],
  ["chat-reading-indicator--spin", 4],
  ["chat-reading-indicator--shadowbox", 3],
  ["chat-reading-indicator--backflip", 2],
  ["chat-reading-indicator--zen", 2],
  ["chat-reading-indicator--drummer", 1],
  ["chat-reading-indicator--peekaboo", 1],
];
const STANCE_WEIGHT_TOTAL = STANCES.reduce((sum, [, weight]) => sum + weight, 0);
const STARTUP_STATUS_LABEL_KEYS = {
  preparing_workspace: "chat.startupStatus.preparingWorkspace",
  provisioning_environment: "chat.startupStatus.provisioningEnvironment",
  preparing_context: "chat.startupStatus.preparingContext",
  starting_model: "chat.startupStatus.startingModel",
} as const satisfies Record<ChatRunStartupPhase, Parameters<typeof t>[0]>;
const TURN_RECAP_DURATION_UNITS = [
  { seconds: 86_400, unit: "day" },
  { seconds: 3_600, unit: "hour" },
  { seconds: 60, unit: "minute" },
  { seconds: 1, unit: "second" },
] as const;

function startupStatusLabel(phase: ChatRunStartupPhase): string {
  return t(STARTUP_STATUS_LABEL_KEYS[phase]);
}

function formatTurnRecapDuration(ms: number): string {
  let remainingSeconds = Math.max(1, Math.round(ms / 1_000));
  const locale = i18n.getLocale();
  const parts: string[] = [];
  for (const { seconds, unit } of TURN_RECAP_DURATION_UNITS) {
    const value = Math.floor(remainingSeconds / seconds);
    if (value === 0) {
      continue;
    }
    parts.push(
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "long",
      }).format(value),
    );
    remainingSeconds -= value * seconds;
    if (parts.length === 2) {
      break;
    }
  }
  return new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(parts);
}

function renderLiveOutputTokens(outputTokens: number | null | undefined) {
  if (outputTokens === null || outputTokens === undefined) {
    return nothing;
  }
  return html`
    <span aria-hidden="true">·</span>
    <span class="chat-working-indicator__tokens">
      ${t("chat.outputTokens", { count: formatCompactTokenCount(outputTokens) })}
    </span>
  `;
}

function stanceClass(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  let roll = ((((hash ^ STANCE_SALT) >>> 0) % 1000) / 1000) * STANCE_WEIGHT_TOTAL;
  for (const [stance, weight] of STANCES) {
    roll -= weight;
    if (roll <= 0) {
      return stance;
    }
  }
  return "";
}

export function renderChatWorkingIndicator(
  part: Extract<ChatItem, { kind: "reading-indicator" }>,
  waitingApproval = false,
  startupPhase?: ChatRunStartupPhase,
  outputTokens?: number | null,
) {
  // The animated claw stays decorative; the text status exposes progress without
  // announcing every elapsed-time tick to screen readers.
  return html`
    <div class="chat-working-indicator" role="status" aria-live="off">
      <div class="chat-bubble chat-reading-indicator ${stanceClass(part.key)}" aria-hidden="true">
        ${icons.claw}
      </div>
      <span class="chat-working-indicator__status">
        ${waitingApproval
          ? html`<span>${t("chat.waitingForApproval")}</span>`
          : startupPhase
            ? html`
                <span>${startupStatusLabel(startupPhase)}</span>
                <openclaw-elapsed-time
                  class="chat-working-indicator__elapsed"
                  .startMs=${part.startedAt}
                ></openclaw-elapsed-time>
                ${renderLiveOutputTokens(outputTokens)}
              `
            : html`
                <span class="agent-chat__sr-only">${t("common.working")}</span>
                <openclaw-elapsed-time
                  class="chat-working-indicator__elapsed"
                  .startMs=${part.startedAt}
                ></openclaw-elapsed-time>
                <openclaw-working-phrase
                  aria-hidden="true"
                  .startMs=${part.startedAt}
                  .seed=${part.key}
                ></openclaw-working-phrase>
                ${renderLiveOutputTokens(outputTokens)}
              `}
      </span>
    </div>
  `;
}

/** Post-turn recap row: once the run settles, the parked claw reports how
 * long the turn took (and its output tokens when the terminal patch carried
 * them). Sticky until the next run replaces it. */
export function renderTurnRecapRow(recap: TurnRecap) {
  // Sub-second turns still read as one second; terminal recaps favor full words.
  const duration = formatTurnRecapDuration(recap.runtimeMs);
  // 0 is a valid count (command-only turns); only null means "unknown".
  const tokens =
    typeof recap.outputTokens === "number"
      ? recap.outputTokens === 1
        ? t("chat.turnRecap.tokensOne")
        : t("chat.turnRecap.tokens", { count: formatCompactTokenCount(recap.outputTokens) })
      : null;
  return html`
    <div class="chat-tasks-status chat-turn-recap" role="status">
      <span class="chat-tasks-status__claw" aria-hidden="true">${icons.claw}</span>
      <span>${t("chat.turnRecap.doneIn", { duration })}</span>
      ${tokens === null
        ? nothing
        : html`
            <span class="chat-tasks-status__sep" aria-hidden="true">·</span>
            <span>${tokens}</span>
          `}
    </div>
  `;
}
