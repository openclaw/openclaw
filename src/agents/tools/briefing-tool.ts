import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { BriefingConfig } from "./briefing-config.js";
import {
  loadBriefingConfig,
  saveBriefingConfig,
  DEFAULT_BRIEFING_CONFIG,
} from "./briefing-config.js";
import { formatMorningBriefing, formatWeeklyRecap, formatSectionError } from "./briefing-format.js";
import {
  fetchCalendarSection,
  fetchEmailSection,
  fetchTicketsSection,
  fetchPrsSection,
  fetchSlackSection,
  fetchShippedSection,
  fetchInProgressSection,
  fetchBlockedSection,
  fetchDiscussionsSection,
  fetchNumbersSection,
  fetchPeopleSection,
} from "./briefing-sections.js";
import { ToolInputError, jsonResult } from "./common.js";

type SectionResult = { title: string; [key: string]: unknown };

const MORNING_FETCHERS: Record<
  string,
  { title: string; fetch: (opts: Record<string, unknown>) => Promise<unknown> }
> = {
  calendar: { title: "Calendar", fetch: fetchCalendarSection },
  email: { title: "Email", fetch: fetchEmailSection },
  tickets: { title: "Tickets", fetch: fetchTicketsSection },
  prs: { title: "PRs", fetch: fetchPrsSection },
  slack: { title: "Slack", fetch: fetchSlackSection },
};

const WEEKLY_FETCHERS: Record<
  string,
  { title: string; fetch: (opts: Record<string, unknown>) => Promise<unknown> }
> = {
  shipped: { title: "Shipped", fetch: fetchShippedSection },
  in_progress: { title: "In Progress", fetch: fetchInProgressSection },
  blocked: { title: "Blocked", fetch: fetchBlockedSection },
  discussions: { title: "Discussions", fetch: fetchDiscussionsSection },
  numbers: { title: "Numbers", fetch: fetchNumbersSection },
  people: { title: "People", fetch: fetchPeopleSection },
};

function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function resolveConfig(): Promise<BriefingConfig> {
  const config = await loadBriefingConfig();
  return config ?? DEFAULT_BRIEFING_CONFIG;
}

async function fetchSections(
  fetchers: Record<
    string,
    { title: string; fetch: (opts: Record<string, unknown>) => Promise<unknown> }
  >,
  enabledSections: string[],
  opts: Record<string, unknown>,
): Promise<{ sections: SectionResult[]; errors: string[] }> {
  const sections: SectionResult[] = [];
  const errors: string[] = [];

  for (const key of enabledSections) {
    const entry = fetchers[key];
    if (!entry) {
      continue;
    }
    try {
      const data = (await entry.fetch(opts)) as SectionResult;
      sections.push(data);
    } catch (err) {
      const errorText = formatSectionError(entry.title, err);
      sections.push({ title: entry.title, error: errorText });
      errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { sections, errors };
}

async function handleMorning(params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  const config = await resolveConfig();
  const date = typeof params.date === "string" ? params.date : undefined;
  const opts: Record<string, unknown> = {};
  if (date) {
    opts.date = date;
  }

  const { sections, errors } = await fetchSections(MORNING_FETCHERS, config.morning.sections, opts);

  const briefing = formatMorningBriefing(sections);
  return jsonResult({ ok: true, briefing, errors });
}

async function handleWeekly(params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  const config = await resolveConfig();
  const weekStartParam = typeof params.week_start === "string" ? params.week_start : undefined;

  let monday: Date;
  if (weekStartParam) {
    monday = new Date(weekStartParam);
  } else {
    monday = getMonday(new Date());
  }

  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  const opts: Record<string, unknown> = {
    weekStart: formatDateStr(monday),
    weekEnd: formatDateStr(friday),
  };

  const { sections, errors } = await fetchSections(WEEKLY_FETCHERS, config.weekly.sections, opts);

  const briefing = formatWeeklyRecap(sections);
  return jsonResult({ ok: true, briefing, errors });
}

async function handleConfigure(params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  const type = params.type as string | undefined;
  if (!type) {
    throw new ToolInputError("type required");
  }
  if (type !== "morning" && type !== "weekly") {
    throw new ToolInputError("type must be morning or weekly");
  }

  const config = await resolveConfig();
  const updated = { ...config, [type]: { ...config[type] } };

  if (Array.isArray(params.sections)) {
    updated[type].sections = params.sections as string[];
  }
  if (typeof params.enabled === "boolean") {
    updated[type].enabled = params.enabled;
  }
  if (typeof params.schedule === "string") {
    updated[type].schedule = params.schedule;
  }
  if (typeof params.delivery_channel === "string") {
    updated[type].delivery_channel = params.delivery_channel;
  }

  await saveBriefingConfig(updated);
  return jsonResult({ ok: true, config: updated });
}

export async function handleBriefingAction(
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const action = params.action as string;

  switch (action) {
    case "morning":
      return handleMorning(params);
    case "weekly":
      return handleWeekly(params);
    case "configure":
      return handleConfigure(params);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
