import type { SettingsAppHost, SettingsHost } from "../app/app-host.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import type { RouteHookOptions } from "../router/types.ts";
import { refreshChat } from "../ui/app-chat.ts";
import { scheduleChatScroll } from "../ui/app-scroll.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
} from "../ui/control-ui-performance.ts";
import { loadAgentFiles } from "../ui/controllers/agent-files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "../ui/controllers/agent-identity.ts";
import { loadAgentSkills } from "../ui/controllers/agent-skills.ts";
import { loadAgents } from "../ui/controllers/agents.ts";
import { loadChannels } from "../ui/controllers/channels.ts";
import { loadConfig, loadConfigSchema } from "../ui/controllers/config.ts";
import { loadCronJobsPage, loadCronRuns, loadCronStatus } from "../ui/controllers/cron.ts";
import { loadDebug } from "../ui/controllers/debug.ts";
import {
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
} from "../ui/controllers/dreaming.ts";
import { loadModelAuthStatusState } from "../ui/controllers/model-auth-status.ts";
import { loadPresence } from "../ui/controllers/presence.ts";
import { loadSessions } from "../ui/controllers/sessions.ts";
import { loadSkills, reconcileSkillsAgentId } from "../ui/controllers/skills.ts";
import { loadUsage } from "../ui/controllers/usage.ts";
import { resolveCronJobLastRunStatus } from "../ui/cron-status.ts";
import { isMonitoredAuthProvider } from "../ui/model-auth-helpers.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../ui/session-key.ts";

export async function loadSettingsPage(host: SettingsHost, app: SettingsAppHost) {
  const primaryRefresh = loadConfig(app);
  loadConfigSchemaAfterPrimary(host, app, primaryRefresh);
  await primaryRefresh;
}

export async function loadUsagePage(app: SettingsAppHost) {
  await loadUsage(app);
}

export async function loadSkillsPage(app: SettingsAppHost) {
  await loadAgents(app);
  reconcileSkillsAgentId(app, app.agentsList);
  await loadSkills(app);
}

export async function loadAgentsPage(host: SettingsHost, app: SettingsAppHost) {
  await refreshAgentsPage(host, app);
}

export async function loadDreamsPage(host: SettingsHost, app: SettingsAppHost) {
  host.selectedAgentId = resolveDreamingAgentIdForSession(host);
  await loadConfig(app);
  await Promise.all([
    loadDreamingStatus(app),
    loadDreamDiary(app),
    loadWikiImportInsights(app),
    loadWikiMemoryPalace(app),
  ]);
}

export async function loadChatPage(host: SettingsHost, app: SettingsAppHost) {
  try {
    await refreshChat(host as unknown as Parameters<typeof refreshChat>[0]);
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      !host.chatHasAutoScrolled,
    );
  } finally {
    void loadModelAuthStatusState(app).catch(() => undefined);
  }
}

export async function loadChannelsPage(host: SettingsHost) {
  await loadChannelsRoute(host);
}

export async function loadCronPage(host: SettingsHost, routeOptions?: RouteHookOptions) {
  await loadCron(host, routeOptions);
}

export async function loadOverview(
  host: SettingsHost,
  opts?: { refresh?: boolean },
  routeOptions?: RouteHookOptions,
) {
  const app = host as SettingsAppHost;
  const overviewSeq = (host.controlUiOverviewRefreshSeq ?? 0) + 1;
  host.controlUiOverviewRefreshSeq = overviewSeq;
  const isCurrentOverviewRefresh = () =>
    host.controlUiOverviewRefreshSeq === overviewSeq &&
    (routeOptions ? routeOptions.shouldRun() : host.routeId === "overview");

  await Promise.allSettled([
    loadChannels(app, false),
    loadPresence(app),
    loadSessions(app),
    loadCronStatus(app),
    loadCronJobsPage(app),
  ]);
  if (isCurrentOverviewRefresh()) {
    buildAttentionItems(app);
  }

  const secondaryStartedAtMs = controlUiNowMs();
  void Promise.allSettled([
    loadDebug(app),
    loadSkills(app),
    isCurrentOverviewRefresh() ? loadUsage(app) : Promise.resolve(),
    loadOverviewLogs(app),
    loadModelAuthStatusState(app, { refresh: opts?.refresh }),
  ]).then((results) => {
    if (!isCurrentOverviewRefresh()) {
      return;
    }
    const status = results.some((result) => result.status === "rejected") ? "error" : "ok";
    buildAttentionItems(app);
    recordControlUiPerformanceEvent(
      app,
      "control-ui.overview.secondary",
      {
        phase: "end",
        status,
        durationMs: roundedControlUiDurationMs(controlUiNowMs() - secondaryStartedAtMs),
      },
      { console: false },
    );
  });
}

export async function loadCron(host: SettingsHost, routeOptions?: RouteHookOptions) {
  const app = host as unknown as SettingsAppHost;
  const activeCronJobId = app.cronRunsScope === "job" ? app.cronRunsJobId : null;
  const cronSeq = (host.controlUiCronRefreshSeq ?? 0) + 1;
  host.controlUiCronRefreshSeq = cronSeq;
  const isCurrentCronRefresh = () =>
    host.controlUiCronRefreshSeq === cronSeq &&
    !routeOptions?.signal.aborted &&
    (routeOptions ? true : host.routeId === "cron");
  const useTableFilters = routeOptions ? !routeOptions.signal.aborted : host.routeId === "cron";
  const runsStartedAtMs = controlUiNowMs();
  const runsRefresh = loadCronRuns(app, activeCronJobId)
    .catch(() => "error" as const)
    .then((status) => {
      if (!isCurrentCronRefresh()) {
        return;
      }
      recordControlUiPerformanceEvent(
        app,
        "control-ui.cron.runs",
        {
          phase: "end",
          status,
          durationMs: roundedControlUiDurationMs(controlUiNowMs() - runsStartedAtMs),
        },
        { console: false },
      );
    });
  void runsRefresh;
  await Promise.all([
    loadChannels(app, false),
    loadCronStatus(app),
    loadCronJobsPage(app, { tableFilters: useTableFilters }),
  ]);
}

async function refreshAgentsPage(host: SettingsHost, app: SettingsAppHost) {
  await loadAgents(app);
  await loadConfig(app);
  const agentIds = host.agentsList?.agents?.map((entry) => entry.id) ?? [];
  if (agentIds.length > 0) {
    void loadAgentIdentities(app, agentIds);
  }
  const agentId =
    host.agentsSelectedId ?? host.agentsList?.defaultId ?? host.agentsList?.agents?.[0]?.id;
  if (!agentId) {
    return;
  }
  void loadAgentIdentity(app, agentId);
  switch (host.agentsPanel) {
    case "files":
      void loadAgentFiles(app, agentId);
      return;
    case "skills":
      void loadAgentSkills(app, agentId);
      return;
    case "channels":
      void loadChannels(app, false);
      return;
    case "cron":
      void loadCron(host);
    case "overview":
    case "tools":
    case undefined:
  }
}

function loadConfigSchemaAfterPrimary(
  host: SettingsHost,
  app: SettingsAppHost,
  primaryRefresh: Promise<unknown>,
) {
  void primaryRefresh.then(
    () => {
      void loadConfigSchema(app).finally(() => host.requestUpdate?.());
    },
    () => undefined,
  );
}

async function loadChannelsRoute(host: SettingsHost) {
  const app = host as unknown as SettingsAppHost;
  const primaryRefresh = Promise.all([loadChannels(app, false), loadConfig(app)]);
  loadConfigSchemaAfterPrimary(host, app, primaryRefresh);
  await primaryRefresh;
}

async function loadOverviewLogs(host: SettingsAppHost) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    const res = await host.client.request("logs.tail", {
      cursor: host.overviewLogCursor || undefined,
      limit: 100,
      maxBytes: 50_000,
    });
    const payload = res as {
      cursor?: number;
      lines?: unknown;
    };
    const lines = Array.isArray(payload.lines)
      ? payload.lines.filter((line): line is string => typeof line === "string")
      : [];
    host.overviewLogLines = [...host.overviewLogLines, ...lines].slice(-500);
    if (typeof payload.cursor === "number") {
      host.overviewLogCursor = payload.cursor;
    }
  } catch {
    /* non-critical */
  }
}

function buildAttentionItems(host: SettingsAppHost) {
  const items: SettingsAppHost["attentionItems"] = [];

  if (host.lastError) {
    items.push({
      severity: "error",
      icon: "x",
      title: "Gateway Error",
      description: host.lastError,
    });
  }

  const auth = host.hello?.auth ?? null;
  if (auth?.scopes && !hasOperatorReadAccess(auth)) {
    items.push({
      severity: "warning",
      icon: "key",
      title: "Missing operator.read scope",
      description:
        "This connection does not have the operator.read scope. Some features may be unavailable.",
      href: "https://docs.openclaw.ai/web/dashboard",
      external: true,
    });
  }

  const skills = host.skillsReport?.skills ?? [];
  const missingDeps = skills.filter((s) => !s.disabled && hasMissingSkillDependencies(s.missing));
  if (missingDeps.length > 0) {
    const names = missingDeps.slice(0, 3).map((s) => s.name);
    const more = missingDeps.length > 3 ? ` +${missingDeps.length - 3} more` : "";
    items.push({
      severity: "warning",
      icon: "zap",
      title: "Skills with missing dependencies",
      description: `${names.join(", ")}${more}`,
    });
  }

  const blocked = skills.filter((s) => s.blockedByAllowlist);
  if (blocked.length > 0) {
    items.push({
      severity: "warning",
      icon: "shield",
      title: `${blocked.length} skill${blocked.length > 1 ? "s" : ""} blocked`,
      description: blocked.map((s) => s.name).join(", "),
    });
  }

  const cronJobs = host.cronJobs ?? [];
  const failedCron = cronJobs.filter((j) => resolveCronJobLastRunStatus(j) === "error");
  if (failedCron.length > 0) {
    items.push({
      severity: "error",
      icon: "clock",
      title: `${failedCron.length} cron job${failedCron.length > 1 ? "s" : ""} failed`,
      description: failedCron.map((j) => j.name).join(", "),
    });
  }

  const now = Date.now();
  const overdue = cronJobs.filter(
    (j) => j.enabled && j.state?.nextRunAtMs != null && now - j.state.nextRunAtMs > 300_000,
  );
  if (overdue.length > 0) {
    items.push({
      severity: "warning",
      icon: "clock",
      title: `${overdue.length} overdue job${overdue.length > 1 ? "s" : ""}`,
      description: overdue.map((j) => j.name).join(", "),
    });
  }

  const modelAuth = host.modelAuthStatusResult;
  if (modelAuth) {
    const monitored = (modelAuth.providers ?? []).filter(isMonitoredAuthProvider);
    const expiredProviders = monitored.filter(
      (p) => p.status === "expired" || p.status === "missing",
    );
    if (expiredProviders.length > 0) {
      items.push({
        severity: "error",
        icon: "key",
        title: t("overview.cards.modelAuthAttentionExpiredTitle"),
        description: t("overview.cards.modelAuthAttentionExpiredDesc", {
          providers: expiredProviders.map((p) => p.displayName).join(", "),
        }),
      });
    }
    const expiringProviders = monitored.filter((p) => p.status === "expiring");
    if (expiringProviders.length > 0) {
      items.push({
        severity: "warning",
        icon: "key",
        title: t("overview.cards.modelAuthAttentionExpiringTitle"),
        description: expiringProviders
          .map((p) =>
            t("overview.cards.modelAuthAttentionExpiringEntry", {
              provider: p.displayName,
              when: p.expiry?.label ?? "soon",
            }),
          )
          .join(", "),
      });
    }
  }

  host.attentionItems = items;
}

function hasMissingSkillDependencies(missing: Record<string, unknown> | null | undefined): boolean {
  if (!missing) {
    return false;
  }
  return Object.values(missing).some((value) => Array.isArray(value) && value.length > 0);
}

function resolveDreamingAgentIdForSession(host: SettingsHost): string {
  return normalizeAgentId(
    parseAgentSessionKey(host.sessionKey)?.agentId ?? host.agentsList?.defaultId ?? "main",
  );
}
