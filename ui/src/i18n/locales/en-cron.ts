import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enCron = {
  cron: {
    suggestions: {
      title: "Starter automations",
      schedules: {
        weekdayMornings: "Weekdays at 9:00 AM",
        everyMorning: "Daily at 8:00 AM",
        weekly: "Mondays at 9:00 AM",
        hourly: "Every hour",
      },
      ideas: {
        repoPulse: {
          name: "Repo pulse",
          tagline: "Overnight issues, PRs, and CI failures, ranked by urgency.",
          prompt:
            "Review overnight activity in my repositories: new issues, pull requests, and CI failures. Summarize the three things that most need my attention today, each with a link and a one-line reason.",
        },
        standupGhostwriter: {
          name: "Standup ghostwriter",
          tagline: "Your standup update, drafted from yesterday's work.",
          prompt:
            "Draft my standup update from yesterday's commits, merged pull requests, and open review threads. Three bullets max: done, doing, blocked.",
        },
        hackerNewsScout: {
          name: "Hacker News scout",
          tagline: "Three links worth your coffee, with hot takes.",
          prompt:
            "Scan today's Hacker News front page for posts about AI agents, developer tooling, and TypeScript. Send me the three most interesting links, each with a one-line hot take.",
        },
        dependencyRadar: {
          name: "Dependency radar",
          tagline: "Outdated or vulnerable dependencies, with upgrade notes.",
          prompt:
            "Check my main project for outdated or vulnerable dependencies. List the notable updates with a one-line risk note each, and draft the upgrade command.",
        },
        watchdog: {
          name: "Night watch",
          tagline: "Hourly health check with a one-line verdict.",
          prompt:
            "Check that my services and gateway are healthy: scan recent logs for new errors, restarts, or unusual load. Reply with a single short all-clear line when everything is fine; if something looks broken, report what failed and where to start looking.",
        },
        polyglotMinute: {
          name: "Polyglot minute",
          tagline: "One useful foreign phrase with your morning coffee.",
          prompt:
            "Teach me one useful phrase in Japanese: the phrase, how to pronounce it, its literal meaning, and when to use it. Keep it under five lines.",
        },
      },
    },
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
    // SAFETY: The canonical English catalog owns cron as an object; extend its lazy page copy.
    Object.assign(en.cron as TranslationMap, enCron.cron);
  },
  { catalog: enCron },
);
