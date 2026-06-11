import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import { t } from "../i18n/index.ts";
import { scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import type { SettingsAppHost, SettingsHost } from "./app-settings.ts";
import {
  beginControlUiRefresh,
  controlUiNowMs,
  finishControlUiRefresh,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
} from "./control-ui-performance.ts";
import { loadAgentFiles } from "./controllers/agent-files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./controllers/agent-identity.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import { loadAgents, loadAgentsRuntimeStatus, loadOpsSummary } from "./controllers/agents.ts";
import { loadAppStudioDashboard } from "./controllers/app-studio-dashboard.ts";
import { loadChannels } from "./controllers/channels.ts";
import { loadConfig, loadConfigSchema } from "./controllers/config.ts";
import type { CronState } from "./controllers/cron.ts";
import { loadDebug } from "./controllers/debug.ts";
import { loadDevices } from "./controllers/devices.ts";
import type { DreamingState } from "./controllers/dreaming.ts";
import { loadExecApprovals } from "./controllers/exec-approvals.ts";
import type { KalshiDashboardView } from "./controllers/kalshi-dashboard.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadModelAuthStatusState } from "./controllers/model-auth-status.ts";
import { loadNodes } from "./controllers/nodes.ts";
import { loadPresence } from "./controllers/presence.ts";
import type { ProjectsState } from "./controllers/projects.ts";
import { loadSelfImprovementRecommendations } from "./controllers/self-improvement.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { loadSkills } from "./controllers/skills.ts";
import { loadUsage } from "./controllers/usage.ts";
import { isMonitoredAuthProvider } from "./model-auth-helpers.ts";
import type { AgentsListResult, AttentionItem } from "./types.ts";
import type { AgentsPanel } from "./views/agents.types.ts";

async function refreshAgentsTab(host: SettingsHost, app: SettingsAppHost) {
  await loadAgents(app);
  const needsConfig =
    host.agentsPanel === "overview" ||
    host.agentsPanel === "tools" ||
    host.agentsPanel === "files" ||
    host.agentsPanel === "skills";
  if (needsConfig) {
    await loadConfig(app);
  }
  const agentIds = host.agentsList?.agents?.map((entry) => entry.id) ?? [];
  if (agentIds.length > 0) {
    void loadAgentIdentities(app, agentIds);
  }
  if (host.agentsPanel === "self-improvement") {
    await loadSelfImprovementRecommendations(app);
    return;
  }
  const agentId =
    host.agentsSelectedId ?? host.agentsList?.defaultId ?? host.agentsList?.agents?.[0]?.id;
  if (!agentId) {
    return;
  }
  void loadAgentIdentity(app, agentId);
  switch (host.agentsPanel) {
    case "room":
      void loadAgentsRuntimeStatus(app);
      void loadOpsSummary(app);
      void loadChannels(app, false);
      void import("./controllers/cron.ts").then(({ loadCronJobsPage, loadCronStatus }) =>
        Promise.allSettled([loadCronStatus(app), loadCronJobsPage(app)]),
      );
      void host.loadKalshiDashboard?.({ view: "workspace" });
      return;
    case "workflows":
      return;
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
      await loadCron(host);
      return;
    case "overview":
    case "tools":
    case undefined:
      return;
  }
}

export async function refreshActiveTabImpl(host: SettingsHost) {
  const app = host as unknown as SettingsAppHost;
  const refreshRun = beginControlUiRefresh(host, host.tab);
  try {
    switch (host.tab) {
      case "config":
      case "communications":
      case "appearance":
      case "automation":
      case "infrastructure":
      case "aiAgents":
        await loadConfigSchema(app);
        await loadConfig(app);
        break;
      case "overview":
        await loadOverview(host);
        break;
      case "appStudio":
        await loadAppStudioDashboard(app, { quiet: true });
        break;
      case "kalshi":
        await (
          host as SettingsHost & {
            loadKalshiDashboard?: (opts?: {
              auditTablePages?: Record<string, number>;
              auditTableQueries?: Record<string, string>;
              force?: boolean;
              quiet?: boolean;
              view?: KalshiDashboardView;
            }) => Promise<void>;
          }
        ).loadKalshiDashboard?.({ view: "full" });
        break;
      case "patternLab":
        await (
          host as SettingsHost & { loadPatternLabDashboard?: () => Promise<void> }
        ).loadPatternLabDashboard?.();
        break;
      case "bookWriter":
        await (
          host as SettingsHost & {
            loadBookWriterDashboard?: (opts?: { quiet?: boolean }) => Promise<void>;
          }
        ).loadBookWriterDashboard?.({ quiet: true });
        break;
      case "musicStudio":
      case "snesStudio":
        break;
      case "channels":
        await loadChannelsTab(host);
        break;
      case "instances":
        await loadPresence(app);
        break;
      case "usage":
        await loadUsage(app);
        break;
      case "sessions":
        await loadSessions(app);
        break;
      case "projects":
        {
          const { loadProjects } = await import("./controllers/projects.ts");
          await loadProjects(app);
        }
        break;
      case "cron":
        await loadCron(host);
        break;
      case "skills":
        await loadSkills(app);
        break;
      case "agents":
      case "agentWorkflows":
        await refreshAgentsTab(host, app);
        break;
      case "nodes":
        await loadNodes(app);
        await Promise.allSettled([loadDevices(app), loadConfig(app), loadExecApprovals(app)]);
        break;
      case "dreams":
        await loadConfig(app);
        {
          const {
            loadDreamDiary,
            loadDreamingStatus,
            loadWikiImportInsights,
            loadWikiMemoryPalace,
          } = await import("./controllers/dreaming.ts");
          await Promise.all([
            loadDreamingStatus(app),
            loadDreamDiary(app),
            loadWikiImportInsights(app),
            loadWikiMemoryPalace(app),
          ]);
        }
        break;
      case "chat":
        {
          const { refreshChat } = await import("./app-chat.ts");
          await refreshChat(host as unknown as Parameters<typeof refreshChat>[0]);
          scheduleChatScroll(
            host as unknown as Parameters<typeof scheduleChatScroll>[0],
            !host.chatHasAutoScrolled,
          );
        }
        break;
      case "debug":
        await loadDebug(app);
        host.eventLog = host.eventLogBuffer;
        break;
      case "logs":
        host.logsAtBottom = true;
        await loadLogs(app, { reset: true });
        scheduleLogsScroll(host as unknown as Parameters<typeof scheduleLogsScroll>[0], true);
        break;
    }
    finishControlUiRefresh(host, refreshRun, "ok");
  } catch (err) {
    finishControlUiRefresh(host, refreshRun, "error");
    throw err;
  }
}

export async function loadOverview(host: SettingsHost, opts?: { refresh?: boolean }) {
  const app = host as SettingsAppHost;
  const { loadCronJobsPage, loadCronStatus } = await import("./controllers/cron.ts");
  const overviewSeq = (host.controlUiOverviewRefreshSeq ?? 0) + 1;
  host.controlUiOverviewRefreshSeq = overviewSeq;
  const isCurrentOverviewRefresh = () =>
    host.controlUiOverviewRefreshSeq === overviewSeq && host.tab === "overview";

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
    loadUsage(app),
    loadOverviewLogs(app),
    // `refresh: true` bypasses the gateway's 60s auth-status cache so a
    // user-initiated refresh surfaces post-re-auth state immediately.
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

export function hasOperatorReadAccess(
  auth: { role?: string; scopes?: readonly string[] } | null,
): boolean {
  if (!auth?.scopes) {
    return false;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: ["operator.read"],
    allowedScopes: auth.scopes,
  });
}

export function hasMissingSkillDependencies(
  missing: Record<string, unknown> | null | undefined,
): boolean {
  if (!missing) {
    return false;
  }
  return Object.values(missing).some((value) => Array.isArray(value) && value.length > 0);
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
  const items: AttentionItem[] = [];

  if (host.lastError) {
    items.push({
      severity: "error",
      icon: "x",
      title: "Gateway Error",
      description: host.lastError,
    });
  }

  const hello = host.hello;
  const auth = (hello as { auth?: { role?: string; scopes?: string[] } } | null)?.auth ?? null;
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
  const failedCron = cronJobs.filter((j) => j.state?.lastStatus === "error");
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
    // Use the same predicate as the Overview card so the two stay in sync.
    // Without this, a `missing` provider shows up on the card but never
    // produces the re-auth attention callout.
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

export async function loadChannelsTab(host: SettingsHost) {
  const app = host as unknown as SettingsAppHost;
  await Promise.all([loadChannels(app, true), loadConfigSchema(app), loadConfig(app)]);
}

export async function loadCron(host: SettingsHost) {
  const app = host as unknown as SettingsAppHost;
  const { loadCronJobsPage, loadCronRuns, loadCronStatus } = await import("./controllers/cron.ts");
  const activeCronJobId = app.cronRunsScope === "job" ? app.cronRunsJobId : null;
  const cronSeq = (host.controlUiCronRefreshSeq ?? 0) + 1;
  host.controlUiCronRefreshSeq = cronSeq;
  const isCurrentCronRefresh = () =>
    host.controlUiCronRefreshSeq === cronSeq && host.tab === "cron";
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
  await Promise.all([loadChannels(app, false), loadCronStatus(app), loadCronJobsPage(app)]);
}

type _KeepRefreshTypesReachable =
  | AgentsListResult
  | AgentsPanel
  | CronState
  | DreamingState
  | ProjectsState;
