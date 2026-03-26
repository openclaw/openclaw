import path from "node:path";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../config/sessions/types.js";
import { resolveTaskProfile, type TaskProfileId } from "./task-profile.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 7;
const PROFILE_IDS: TaskProfileId[] = ["coding", "research", "ops", "assistant"];

export type WorkspaceHealthDashboard = {
  workspaceDir: string;
  generatedAt: number;
  recentDays: number;
  matchedSessions: number;
  activeSessions: number;
  reportsCount: number;
  verifiedSessions: number;
  profiles: Array<{
    id: TaskProfileId;
    sessions: number;
    verifiedSessions: number;
    verifyPassedSessions: number;
    failedSessions: number;
    retriedSessions: number;
    totalEstimatedCostUsd: number;
    avgRuntimeMs?: number;
    avgTrackedPromptChars?: number;
    avgTotalTokens?: number;
  }>;
  overall: WorkspaceHealthWindow;
  trends: { current: WorkspaceHealthWindow; previous: WorkspaceHealthWindow };
  attention: string[];
};

export type WorkspaceHealthWindow = {
  sessions: number;
  verifiedSessions: number;
  verifyPassedSessions: number;
  failedSessions: number;
  retriedSessions: number;
  exhaustedSessions: number;
  totalEstimatedCostUsd: number;
  avgRuntimeMs?: number;
  avgTrackedPromptChars?: number;
  avgTotalTokens?: number;
  topPromptComponent?: { label: string; avgChars: number; share: number };
  topFailureCategory?: string;
  topRetryReason?: string;
};

function normalizePath(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function matchesWorkspace(entry: SessionEntry, workspaceDir: string): boolean {
  const expected = normalizePath(workspaceDir);
  if (!expected) {
    return false;
  }
  return [
    normalizePath(entry.systemPromptReport?.workspaceDir),
    normalizePath(entry.spawnedWorkspaceDir),
    normalizePath(entry.systemPromptReport?.delegationProfile?.workspaceDir),
  ].includes(expected);
}

function resolveTrackedPromptBudget(entry: SessionEntry) {
  const report = entry.systemPromptReport;
  if (!report) {
    return undefined;
  }
  if (report.promptBudget) {
    return report.promptBudget;
  }
  const workspaceInjectedChars = report.injectedWorkspaceFiles.reduce(
    (sum, file) => sum + Math.max(0, file.injectedChars),
    0,
  );
  const skillsPromptChars = Math.max(0, report.skills.promptChars);
  const toolListChars = Math.max(0, report.tools.listChars);
  const toolSchemaChars = Math.max(0, report.tools.schemaChars);
  const trackedInsideSystemPrompt = workspaceInjectedChars + skillsPromptChars + toolListChars;
  return {
    totalTrackedChars: Math.max(0, report.systemPrompt.chars) + toolSchemaChars,
    workspaceInjectedChars,
    skillsPromptChars,
    toolListChars,
    otherSystemPromptChars: Math.max(0, report.systemPrompt.chars - trackedInsideSystemPrompt),
    toolSchemaChars,
  };
}

function resolveTaskProfileId(entry: SessionEntry, workspaceDir: string): TaskProfileId {
  const report = entry.systemPromptReport;
  return (
    report?.taskProfile?.id ??
    resolveTaskProfile({
      sessionKey: report?.sessionKey,
      workspaceDir: report?.workspaceDir ?? workspaceDir,
      tools: report?.tools.entries.map((tool) => ({ name: tool.name }) as never) ?? [],
    }).id
  );
}

function resolveTimestamp(entry: SessionEntry): number {
  return Math.max(
    entry.updatedAt ?? 0,
    entry.endedAt ?? 0,
    entry.systemPromptReport?.generatedAt ?? 0,
    entry.verifyReport?.generatedAt ?? 0,
    entry.failureReport?.generatedAt ?? 0,
    entry.retryReport?.generatedAt ?? 0,
  );
}

function hasRetryPressure(entry: SessionEntry): boolean {
  return (entry.retryReport?.retriesUsed ?? 0) > 0 || entry.retryReport?.status === "exhausted";
}

function buildWindow(entries: SessionEntry[]): WorkspaceHealthWindow {
  const sums = { runtimeMs: 0, trackedChars: 0, totalTokens: 0 };
  const counts = { runtimeMs: 0, trackedChars: 0, totalTokens: 0, verified: 0, verifyPassed: 0 };
  const promptSums = new Map<string, number>();
  const failureCounts = new Map<string, number>();
  const retryCounts = new Map<string, number>();
  let failedSessions = 0;
  let retriedSessions = 0;
  let exhaustedSessions = 0;
  let totalEstimatedCostUsd = 0;

  for (const entry of entries) {
    const tracked = resolveTrackedPromptBudget(entry);
    if (tracked) {
      counts.trackedChars += 1;
      sums.trackedChars += tracked.totalTrackedChars;
      promptSums.set(
        "workspace files",
        (promptSums.get("workspace files") ?? 0) + tracked.workspaceInjectedChars,
      );
      promptSums.set(
        "skills list",
        (promptSums.get("skills list") ?? 0) + tracked.skillsPromptChars,
      );
      promptSums.set("tool list", (promptSums.get("tool list") ?? 0) + tracked.toolListChars);
      promptSums.set(
        "other system prompt",
        (promptSums.get("other system prompt") ?? 0) + tracked.otherSystemPromptChars,
      );
      promptSums.set(
        "tool schemas",
        (promptSums.get("tool schemas") ?? 0) + tracked.toolSchemaChars,
      );
    }
    if (typeof entry.runtimeMs === "number" && entry.runtimeMs > 0) {
      counts.runtimeMs += 1;
      sums.runtimeMs += entry.runtimeMs;
    }
    const totalTokens = resolveFreshSessionTotalTokens(entry);
    if (typeof totalTokens === "number") {
      counts.totalTokens += 1;
      sums.totalTokens += totalTokens;
    }
    if (typeof entry.estimatedCostUsd === "number" && Number.isFinite(entry.estimatedCostUsd)) {
      totalEstimatedCostUsd += entry.estimatedCostUsd;
    }
    if (
      entry.verifyReport &&
      entry.verifyReport.status !== "skipped" &&
      entry.verifyReport.checksRun > 0
    ) {
      counts.verified += 1;
      if (entry.verifyReport.status === "passed") {
        counts.verifyPassed += 1;
      }
    }
    if (entry.failureReport?.status === "failed") {
      failedSessions += 1;
      failureCounts.set(
        entry.failureReport.category,
        (failureCounts.get(entry.failureReport.category) ?? 0) + 1,
      );
    }
    if (hasRetryPressure(entry)) {
      retriedSessions += 1;
    }
    if (entry.retryReport?.status === "exhausted") {
      exhaustedSessions += 1;
    }
    for (const retryEntry of entry.retryReport?.entries ?? []) {
      retryCounts.set(retryEntry.reason, (retryCounts.get(retryEntry.reason) ?? 0) + 1);
    }
  }

  const topComponent = [...promptSums.entries()].toSorted((a, b) => b[1] - a[1])[0];
  const avgTrackedPromptChars =
    counts.trackedChars > 0 ? sums.trackedChars / counts.trackedChars : undefined;
  const topPromptComponent =
    topComponent && avgTrackedPromptChars
      ? {
          label: topComponent[0],
          avgChars: topComponent[1] / counts.trackedChars,
          share: topComponent[1] / (avgTrackedPromptChars * counts.trackedChars),
        }
      : undefined;

  return {
    sessions: entries.length,
    verifiedSessions: counts.verified,
    verifyPassedSessions: counts.verifyPassed,
    failedSessions,
    retriedSessions,
    exhaustedSessions,
    totalEstimatedCostUsd,
    avgRuntimeMs: counts.runtimeMs > 0 ? sums.runtimeMs / counts.runtimeMs : undefined,
    avgTrackedPromptChars,
    avgTotalTokens: counts.totalTokens > 0 ? sums.totalTokens / counts.totalTokens : undefined,
    topPromptComponent,
    topFailureCategory: [...failureCounts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0],
    topRetryReason: [...retryCounts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0],
  };
}

export function buildWorkspaceHealthDashboard(params: {
  workspaceDir: string;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  now?: number;
}): WorkspaceHealthDashboard {
  const now = params.now ?? Date.now();
  const store = { ...params.sessionStore };
  if (params.sessionKey && params.sessionEntry) {
    store[params.sessionKey] = params.sessionEntry;
  }
  const entries = Object.values(store).filter((entry) =>
    matchesWorkspace(entry, params.workspaceDir),
  );
  const reportsCount = entries.filter((entry) => entry.systemPromptReport).length;
  const activeSessions = entries.filter(
    (entry) => entry.status === "running" || (entry.startedAt && !entry.endedAt),
  ).length;
  const recentCutoff = now - RECENT_DAYS * DAY_MS;
  const previousCutoff = recentCutoff - RECENT_DAYS * DAY_MS;
  const overall = buildWindow(entries);
  const current = buildWindow(entries.filter((entry) => resolveTimestamp(entry) >= recentCutoff));
  const previous = buildWindow(
    entries.filter((entry) => {
      const timestamp = resolveTimestamp(entry);
      return timestamp >= previousCutoff && timestamp < recentCutoff;
    }),
  );
  const profiles = PROFILE_IDS.map((id) => {
    const scoped = entries.filter(
      (entry) => resolveTaskProfileId(entry, params.workspaceDir) === id,
    );
    const window = buildWindow(scoped);
    return {
      id,
      sessions: scoped.length,
      verifiedSessions: window.verifiedSessions,
      verifyPassedSessions: window.verifyPassedSessions,
      failedSessions: window.failedSessions,
      retriedSessions: window.retriedSessions,
      totalEstimatedCostUsd: window.totalEstimatedCostUsd,
      avgRuntimeMs: window.avgRuntimeMs,
      avgTrackedPromptChars: window.avgTrackedPromptChars,
      avgTotalTokens: window.avgTotalTokens,
    };
  }).filter((entry) => entry.sessions > 0);
  const attention = [
    overall.topPromptComponent?.label === "tool schemas"
      ? "Tool schemas are still the dominant prompt cost."
      : undefined,
    overall.topFailureCategory
      ? `${overall.topFailureCategory} is the top recorded failure category.`
      : undefined,
    current.retriedSessions > previous.retriedSessions
      ? "Retry pressure increased in the latest 7-day window."
      : undefined,
    current.avgTrackedPromptChars &&
    previous.avgTrackedPromptChars &&
    current.avgTrackedPromptChars > previous.avgTrackedPromptChars
      ? "Average tracked prompt size increased in the latest 7-day window."
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  return {
    workspaceDir: params.workspaceDir,
    generatedAt: now,
    recentDays: RECENT_DAYS,
    matchedSessions: entries.length,
    activeSessions,
    reportsCount,
    verifiedSessions: overall.verifiedSessions,
    profiles,
    overall,
    trends: { current, previous },
    attention: attention.slice(0, 4),
  };
}
