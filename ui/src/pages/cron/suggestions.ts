/**
 * Curated automation ideas for the Automations page.
 *
 * Each idea prefills the inline create form. Nothing here talks
 * to the gateway or adds config surface.
 */

import { html } from "lit";
import { icons } from "../../components/icons.ts";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { CronFormState } from "../../lib/cron/types.ts";

type CronSuggestion = {
  id: string;
  emoji: string;
  nameKey: string;
  taglineKey: string;
  promptKey: string;
  scheduleKey: string;
  schedule: Partial<CronFormState>;
};

// Schedule shapes ported from the retired quick-create presets.
const WEEKDAY_MORNINGS: Partial<CronFormState> = {
  scheduleKind: "cron",
  cronExpr: "0 9 * * 1-5",
};
const EVERY_MORNING: Partial<CronFormState> = { scheduleKind: "cron", cronExpr: "0 8 * * *" };
const WEEKLY: Partial<CronFormState> = { scheduleKind: "cron", cronExpr: "0 9 * * 1" };
const HOURLY: Partial<CronFormState> = {
  scheduleKind: "every",
  everyAmount: "1",
  everyUnit: "hours",
};

function suggestion(
  id: string,
  emoji: string,
  scheduleKey: string,
  schedule: Partial<CronFormState>,
): CronSuggestion {
  return {
    id,
    emoji,
    nameKey: `cron.suggestions.ideas.${id}.name`,
    taglineKey: `cron.suggestions.ideas.${id}.tagline`,
    promptKey: `cron.suggestions.ideas.${id}.prompt`,
    scheduleKey,
    schedule,
  };
}

const CRON_SUGGESTIONS: CronSuggestion[] = [
  suggestion("repoPulse", "🐙", "cron.suggestions.schedules.weekdayMornings", WEEKDAY_MORNINGS),
  suggestion(
    "standupGhostwriter",
    "👻",
    "cron.suggestions.schedules.weekdayMornings",
    WEEKDAY_MORNINGS,
  ),
  suggestion("hackerNewsScout", "🔭", "cron.suggestions.schedules.everyMorning", EVERY_MORNING),
  suggestion("dependencyRadar", "🛰️", "cron.suggestions.schedules.weekly", WEEKLY),
  suggestion("watchdog", "🦉", "cron.suggestions.schedules.hourly", HOURLY),
  suggestion("polyglotMinute", "🗣️", "cron.suggestions.schedules.everyMorning", EVERY_MORNING),
];

function suggestionFormPatch(idea: CronSuggestion): Partial<CronFormState> {
  return {
    name: t(idea.nameKey),
    payloadText: t(idea.promptKey),
    payloadKind: "agentTurn",
    sessionTarget: "isolated",
    wakeMode: "now",
    deleteAfterRun: false,
    enabled: true,
    ...idea.schedule,
  };
}

export function renderCronSuggestions(
  onOpenCreate: (patch: Partial<CronFormState>) => void,
  busy: boolean,
) {
  // Starter ideas are drill-in rows: activating one prefills the create form.
  return renderSettingsSection(
    { title: t("cron.suggestions.title") },
    CRON_SUGGESTIONS.map(
      (idea) => html`
        <button
          type="button"
          class="settings-row settings-row--nav cron-suggestion"
          data-suggestion=${idea.id}
          ?disabled=${busy}
          @click=${() => onOpenCreate(suggestionFormPatch(idea))}
        >
          <div class="settings-row__text">
            <span class="settings-row__title">
              <span aria-hidden="true">${idea.emoji}</span> ${t(idea.nameKey)}
            </span>
            <span class="settings-row__desc">${t(idea.taglineKey)}</span>
          </div>
          <div class="settings-row__control">
            <span class="settings-row__value">${t(idea.scheduleKey)}</span>
            <span class="settings-row__chevron">${icons.chevronRight}</span>
          </div>
        </button>
      `,
    ),
  );
}
