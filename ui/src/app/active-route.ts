// Control UI active route lifecycle and refresh orchestration.
import { t } from "../i18n/index.ts";
import { createRouteModules, ROUTE_RECORDS, type RouteId } from "../routes/route-registry.ts";
import { createRouteTree } from "../routes/route-tree.ts";
import type { RouteRefresh, RouteRefreshOptions } from "../routes/route-types.ts";
import { refreshChat } from "../ui/app-chat.ts";
import {
  startDebugPolling,
  startLogsPolling,
  startNodesPolling,
  stopDebugPolling,
  stopLogsPolling,
  stopNodesPolling,
} from "../ui/app-polling.ts";
import { scheduleChatScroll, scheduleLogsScroll } from "../ui/app-scroll.ts";
import {
  beginControlUiRefresh,
  controlUiNowMs,
  finishControlUiRefresh,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
  scheduleControlUiRouteVisibleTiming,
} from "../ui/control-ui-performance.ts";
import { loadAgentFiles } from "../ui/controllers/agent-files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "../ui/controllers/agent-identity.ts";
import { loadAgentSkills } from "../ui/controllers/agent-skills.ts";
import { loadAgents } from "../ui/controllers/agents.ts";
import { loadChannels } from "../ui/controllers/channels.ts";
import { loadConfig, loadConfigSchema } from "../ui/controllers/config.ts";
import { loadCronJobsPage, loadCronRuns, loadCronStatus } from "../ui/controllers/cron.ts";
import { loadDebug } from "../ui/controllers/debug.ts";
import { loadDevices } from "../ui/controllers/devices.ts";
import {
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
} from "../ui/controllers/dreaming.ts";
import { loadExecApprovals } from "../ui/controllers/exec-approvals.ts";
import { loadLogs } from "../ui/controllers/logs.ts";
import { loadModelAuthStatusState } from "../ui/controllers/model-auth-status.ts";
import { loadNodes } from "../ui/controllers/nodes.ts";
import { loadPresence } from "../ui/controllers/presence.ts";
import { loadSessions } from "../ui/controllers/sessions.ts";
import { loadSkills, reconcileSkillsAgentId } from "../ui/controllers/skills.ts";
import { loadUsage } from "../ui/controllers/usage.ts";
import {
  loadWorkboard,
  stopWorkboardLifecycleRefresh,
  stopWorkboardPolling,
} from "../ui/controllers/workboard.ts";
import { resolveCronJobLastRunStatus } from "../ui/cron-status.ts";
import { isMonitoredAuthProvider } from "../ui/model-auth-helpers.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../ui/session-key.ts";
import { resetChatViewState } from "../ui/views/chat.ts";
import type { SettingsAppHost, SettingsHost } from "./app-host.ts";
import { hasOperatorReadAccess, hasOperatorWriteAccess } from "./operator-access.ts";

const refreshSettingsRoute: RouteRefresh = async ({ host, app }) => {
  const primaryRefresh = loadConfig(app);
  loadConfigSchemaAfterPrimary(host, app, primaryRefresh);
  await primaryRefresh;
};

type AppRefreshRouteId = Exclude<RouteId, "skill-workshop">;

const ACTIVE_ROUTE_REFRESHERS = {
  config: refreshSettingsRoute,
  communications: refreshSettingsRoute,
  appearance: refreshSettingsRoute,
  automation: refreshSettingsRoute,
  mcp: refreshSettingsRoute,
  infrastructure: refreshSettingsRoute,
  "ai-agents": refreshSettingsRoute,
  overview: ({ host }) => loadOverview(host),
  activity: () => undefined,
  workboard: async ({ host, app }) => {
    await Promise.all([
      loadConfig(app),
      loadSessions(app),
      loadAgents(app),
      loadWorkboard({
        host,
        client: app.client,
        force: true,
        requestUpdate: host.requestUpdate,
        refreshDiagnostics: hasOperatorWriteAccess(app.hello?.auth ?? null),
      }),
    ]);
  },
  channels: ({ host }) => loadChannelsRoute(host),
  instances: ({ app }) => loadPresence(app),
  usage: ({ app }) => loadUsage(app),
  sessions: async ({ app }) => {
    await Promise.all([loadConfig(app), loadSessions(app)]);
  },
  cron: ({ host }) => loadCron(host),
  skills: async ({ app }) => {
    await loadAgents(app);
    reconcileSkillsAgentId(app, app.agentsList);
    await loadSkills(app);
  },
  agents: ({ host, app }) => refreshAgentsRoute(host, app),
  nodes: async ({ app }) => {
    await loadNodes(app);
    await Promise.allSettled([loadDevices(app), loadConfig(app), loadExecApprovals(app)]);
  },
  dreams: async ({ host, app }) => {
    host.selectedAgentId = resolveDreamingAgentIdForSession(host);
    await loadConfig(app);
    await Promise.all([
      loadDreamingStatus(app),
      loadDreamDiary(app),
      loadWikiImportInsights(app),
      loadWikiMemoryPalace(app),
    ]);
  },
  chat: async ({ host, app, opts }) => {
    try {
      await refreshChat(host as unknown as Parameters<typeof refreshChat>[0], {
        awaitHistory: opts?.chatStartup === true,
        startup: opts?.chatStartup === true,
      });
      scheduleChatScroll(
        host as unknown as Parameters<typeof scheduleChatScroll>[0],
        !host.chatHasAutoScrolled,
      );
    } finally {
      void loadModelAuthStatusState(app).catch(() => undefined);
    }
  },
  debug: async ({ host, app }) => {
    await loadDebug(app);
    host.eventLog = host.eventLogBuffer;
  },
  logs: async ({ host, app }) => {
    host.logsAtBottom = true;
    await loadLogs(app, { reset: true });
    scheduleLogsScroll(host as unknown as Parameters<typeof scheduleLogsScroll>[0], true);
  },
} satisfies Record<AppRefreshRouteId, RouteRefresh>;

const ACTIVE_ROUTE_TREE = createRouteTree({
  records: ROUTE_RECORDS,
  routeModules: createRouteModules(),
  refreshers: ACTIVE_ROUTE_REFRESHERS,
});

export function applyActiveRouteTransition(
  host: SettingsHost,
  previous: RouteId,
  next: RouteId,
): void {
  if (previous !== next) {
    scheduleControlUiRouteVisibleTiming(host, previous, next);
    clearPendingSessionsChangedReload(host);
  }

  if (previous === "chat" && next !== "chat") {
    resetChatViewState();
  }

  if (next === "chat") {
    host.chatHasAutoScrolled = false;
  }
  (next === "logs" ? startLogsPolling : stopLogsPolling)(
    host as unknown as Parameters<typeof startLogsPolling>[0],
  );
  (next === "nodes" ? startNodesPolling : stopNodesPolling)(
    host as unknown as Parameters<typeof startNodesPolling>[0],
  );
  (next === "debug" ? startDebugPolling : stopDebugPolling)(
    host as unknown as Parameters<typeof startDebugPolling>[0],
  );
  if (next !== "workboard") {
    stopWorkboardPolling(host as unknown as Parameters<typeof stopWorkboardPolling>[0]);
    stopWorkboardLifecycleRefresh(
      host as unknown as Parameters<typeof stopWorkboardLifecycleRefresh>[0],
    );
  }
}

export async function refreshActiveRoute(
  host: SettingsHost,
  opts?: RouteRefreshOptions,
): Promise<void> {
  const app = host as unknown as SettingsAppHost;
  const refreshRun = beginControlUiRefresh(host, host.routeId);
  try {
    await ACTIVE_ROUTE_TREE.get(host.routeId)?.refresh?.({ host, app, opts });
    finishControlUiRefresh(host, refreshRun, "ok");
  } catch (err) {
    finishControlUiRefresh(host, refreshRun, "error");
    throw err;
  }
}

export async function loadOverview(host: SettingsHost, opts?: { refresh?: boolean }) {
  const app = host as SettingsAppHost;
  const overviewSeq = (host.controlUiOverviewRefreshSeq ?? 0) + 1;
  host.controlUiOverviewRefreshSeq = overviewSeq;
  const isCurrentOverviewRefresh = () =>
    host.controlUiOverviewRefreshSeq === overviewSeq && host.routeId === "overview";

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

export async function loadCron(host: SettingsHost) {
  const app = host as unknown as SettingsAppHost;
  const activeCronJobId = app.cronRunsScope === "job" ? app.cronRunsJobId : null;
  const cronSeq = (host.controlUiCronRefreshSeq ?? 0) + 1;
  host.controlUiCronRefreshSeq = cronSeq;
  const isCurrentCronRefresh = () =>
    host.controlUiCronRefreshSeq === cronSeq && host.routeId === "cron";
  const useTableFilters = host.routeId === "cron";
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

function clearPendingSessionsChangedReload(host: SettingsHost): void {
  if (host.sessionsChangedReloadTimer == null) {
    return;
  }
  globalThis.clearTimeout(host.sessionsChangedReloadTimer);
  host.sessionsChangedReloadTimer = null;
}

async function refreshAgentsRoute(host: SettingsHost, app: SettingsAppHost) {
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
