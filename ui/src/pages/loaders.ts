import type { SettingsAppHost, SettingsHost } from "../app/app-host.ts";
import { scheduleChatScroll } from "../ui/app-scroll.ts";
import {
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
} from "../ui/controllers/dreaming.ts";
import { loadModelAuthStatusState } from "../ui/controllers/model-auth-status.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../ui/session-key.ts";
import { loadAgents } from "./agents/data.ts";
import { refreshChat } from "./chat/data.ts";
import { loadConfig, loadConfigSchema } from "./config/data.ts";
import { loadSessions } from "./sessions/data.ts";
import { loadUsage } from "./usage/data.ts";

export async function loadSettingsPage(host: SettingsHost, app: SettingsAppHost) {
  const primaryRefresh = loadConfig(app);
  loadConfigSchemaAfterPrimary(host, app, primaryRefresh);
  await primaryRefresh;
}

export async function loadUsagePage(app: SettingsAppHost) {
  await loadUsage(app);
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

function resolveDreamingAgentIdForSession(host: SettingsHost): string {
  return normalizeAgentId(
    parseAgentSessionKey(host.sessionKey)?.agentId ?? host.agentsList?.defaultId ?? "main",
  );
}
