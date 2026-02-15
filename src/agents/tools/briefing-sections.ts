import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const defaultGatewayOpts: GatewayCallOptions = { timeoutMs: 30_000 };

export async function fetchCalendarSection(opts: Record<string, unknown>): Promise<unknown> {
  const date = typeof opts.date === "string" ? opts.date : undefined;
  const params: Record<string, unknown> = { org: "all" };
  if (date) {
    params.date = date;
  }
  return await callGatewayTool("calendar.today", defaultGatewayOpts, params);
}

export async function fetchEmailSection(opts: Record<string, unknown>): Promise<unknown> {
  const params: Record<string, unknown> = { org: "all" };
  if (opts.date) {
    params.date = opts.date;
  }
  return await callGatewayTool("gmail.triage", defaultGatewayOpts, params);
}

export async function fetchTicketsSection(opts: Record<string, unknown>): Promise<unknown> {
  const params: Record<string, unknown> = { status: "in_progress" };
  if (opts.date) {
    params.date = opts.date;
  }
  return await callGatewayTool("asana.tasks", defaultGatewayOpts, params);
}

export async function fetchPrsSection(opts: Record<string, unknown>): Promise<unknown> {
  const params: Record<string, unknown> = { state: "open" };
  if (opts.date) {
    params.date = opts.date;
  }
  return await callGatewayTool("github.prs", defaultGatewayOpts, params);
}

export async function fetchSlackSection(opts: Record<string, unknown>): Promise<unknown> {
  const params: Record<string, unknown> = { period: "today" };
  if (opts.date) {
    params.date = opts.date;
  }
  return await callGatewayTool("slack_read.summarize", defaultGatewayOpts, params);
}

export async function fetchShippedSection(opts: Record<string, unknown>): Promise<unknown> {
  return await callGatewayTool("github.prs", defaultGatewayOpts, {
    state: "merged",
    since: opts.weekStart,
    until: opts.weekEnd,
  });
}

export async function fetchInProgressSection(opts: Record<string, unknown>): Promise<unknown> {
  return await callGatewayTool("asana.sprint_status", defaultGatewayOpts, {
    weekStart: opts.weekStart,
    weekEnd: opts.weekEnd,
  });
}

export async function fetchBlockedSection(opts: Record<string, unknown>): Promise<unknown> {
  return await callGatewayTool("asana.tasks", defaultGatewayOpts, {
    status: "blocked",
    weekStart: opts.weekStart,
    weekEnd: opts.weekEnd,
  });
}

export async function fetchDiscussionsSection(opts: Record<string, unknown>): Promise<unknown> {
  return await callGatewayTool("slack_read.summarize", defaultGatewayOpts, {
    period: "this_week",
    weekStart: opts.weekStart,
    weekEnd: opts.weekEnd,
  });
}

export async function fetchNumbersSection(opts: Record<string, unknown>): Promise<unknown> {
  return await callGatewayTool("github.commits", defaultGatewayOpts, {
    since: opts.weekStart,
    until: opts.weekEnd,
  });
}

export async function fetchPeopleSection(opts: Record<string, unknown>): Promise<unknown> {
  return await callGatewayTool("people.search", defaultGatewayOpts, {
    weekStart: opts.weekStart,
    weekEnd: opts.weekEnd,
  });
}
