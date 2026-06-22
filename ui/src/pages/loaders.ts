import type { SettingsAppHost, SettingsHost } from "../app/app-host.ts";
import type { RouteHookOptions } from "../router/types.ts";
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
import { loadCronJobsPage, loadCronRuns, loadCronStatus } from "../ui/controllers/cron.ts";
import {
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
} from "../ui/controllers/dreaming.ts";
import { loadModelAuthStatusState } from "../ui/controllers/model-auth-status.ts";
import { loadSkills, reconcileSkillsAgentId } from "../ui/controllers/skills.ts";
import { loadUsage } from "../ui/controllers/usage.ts";
import { resolveCronJobLastRunStatus } from "../ui/cron-status.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../ui/session-key.ts";
import {
  createChatSessionsLoadOverrides,
  refreshChat,
  scopedAgentListParamsForSession,
} from "./chat/data.ts";
import { loadConfig, loadConfigSchema } from "./config/data.ts";
import { loadSessions } from "./sessions/data.ts";

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
  // Capture this before refreshChat seeds a one-row result from history.
  const hadSessionsResult = Boolean(app.sessionsResult);
  try {
    await refreshChat(host as unknown as Parameters<typeof refreshChat>[0]);
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      !host.chatHasAutoScrolled,
    );
  } finally {
    void loadModelAuthStatusState(app).catch(() => undefined);
    if (!hadSessionsResult) {
      void loadSessions(app, {
        ...createChatSessionsLoadOverrides(app),
        ...scopedAgentListParamsForSession(app, app.sessionKey),
        backgroundHydrate: true,
      }).catch(() => undefined);
    }
  }
}

export async function loadChannelsPage(host: SettingsHost) {
  await loadChannelsRoute(host);
}

export async function loadCronPage(host: SettingsHost, routeOptions?: RouteHookOptions) {
  await loadCron(host, routeOptions);
}

export async function loadCron(host: SettingsHost, routeOptions?: RouteHookOptions) {
  const app = host as unknown as SettingsAppHost;
  const activeCronJobId = app.cronRunsScope === "job" ? app.cronRunsJobId : null;
  const cronSeq = (host.controlUiCronRefreshSeq ?? 0) + 1;
  host.controlUiCronRefreshSeq = cronSeq;
  const isCurrentCronRefresh = () =>
    host.controlUiCronRefreshSeq === cronSeq && !routeOptions?.signal.aborted;
  const useTableFilters = routeOptions ? !routeOptions.signal.aborted : true;
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

function resolveDreamingAgentIdForSession(host: SettingsHost): string {
  return normalizeAgentId(
    parseAgentSessionKey(host.sessionKey)?.agentId ?? host.agentsList?.defaultId ?? "main",
  );
}
