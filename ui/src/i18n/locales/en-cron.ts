import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enCron = {
  cron: {
    list: {
      viewLabel: "Automation views",
      sessionFilter: "Automations attached to this session.",
      showAll: "Show all automations",
      searchPlaceholder: "Search automations",
      newTask: "New automation",
      filters: "Filters",
      shownOf: "{shown} of {total}",
      emptyTitle: "No automations yet",
      emptyHint: "Describe what OpenClaw should do and when — it runs on schedule.",
      noMatching: "No automations match the current filters.",
      loadMore: "Load more",
      loading: "Loading...",
      schedulerOff: "Scheduler disabled",
      refresh: "Refresh",
      refreshing: "Refreshing...",
      paused: "Paused",
      autoDisabledRunFailures: "Auto-disabled · {count} run failures",
      autoDisabledScheduleErrors: "Auto-disabled · {count} schedule errors",
      tasksTab: "Automations",
      activityTab: "Run history",
    },
  },
} satisfies TranslationMap;

export const registerCronEnglish = Object.assign(
  () => {
    // SAFETY: The canonical English catalog owns cron as an object; extend only its lazy list copy.
    Object.assign(en.cron as TranslationMap, enCron.cron);
  },
  { catalog: enCron },
);
