import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { GatewayBrowserClient, type GatewayEventFrame, type GatewayHelloOk } from "./gateway";
import { loadSettings, saveSettings, type UiSettings } from "./storage";
import { renderApp } from "./app-render";
import type { Tab } from "./navigation";
import type {
  ConfigSnapshot,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  PresenceEntry,
  ProvidersStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import type { CronFormState, TelegramForm } from "./ui-types";
import { loadChatHistory, sendChat, handleChatEvent } from "./controllers/chat";
import { loadNodes } from "./controllers/nodes";
import { loadConfig } from "./controllers/config";
import {
  loadProviders,
  logoutWhatsApp,
  saveTelegramConfig,
  startWhatsAppLogin,
  waitWhatsAppLogin,
} from "./controllers/connections";
import { loadPresence } from "./controllers/presence";
import { loadSessions } from "./controllers/sessions";
import {
  loadCronJobs,
  loadCronStatus,
} from "./controllers/cron";
import {
  loadSkills,
} from "./controllers/skills";
import { loadDebug } from "./controllers/debug";

type EventLogEntry = {
  ts: number;
  event: string;
  payload?: unknown;
};

const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  enabled: true,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payloadKind: "systemEvent",
  payloadText: "",
  deliver: false,
  channel: "last",
  to: "",
  timeoutSeconds: "",
  postToMainPrefix: "",
};

@customElement("clawdis-app")
export class ClawdisApp extends LitElement {
  @state() settings: UiSettings = loadSettings();
  @state() password = "";
  @state() tab: Tab = "chat";
  @state() connected = false;
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() eventLog: EventLogEntry[] = [];

  @state() sessionKey = this.settings.sessionKey;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatStream: string | null = null;
  @state() chatRunId: string | null = null;
  @state() chatThinkingLevel: string | null = null;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configSnapshot: ConfigSnapshot | null = null;

  @state() providersLoading = false;
  @state() providersSnapshot: ProvidersStatusSnapshot | null = null;
  @state() providersError: string | null = null;
  @state() providersLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() telegramForm: TelegramForm = {
    token: "",
    requireMention: true,
    allowFrom: "",
    proxy: "",
    webhookUrl: "",
    webhookSecret: "",
    webhookPath: "",
  };
  @state() telegramSaving = false;
  @state() telegramTokenLocked = false;
  @state() telegramConfigStatus: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = "";
  @state() sessionsFilterLimit = "120";
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;

  @state() cronLoading = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronRunsJobId: string | null = null;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronBusy = false;

  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSnapshot | null = null;
  @state() debugModels: unknown[] = [];
  @state() debugHeartbeat: unknown | null = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.connect();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    if (
      this.tab === "chat" &&
      (changed.has("chatMessages") ||
        changed.has("chatStream") ||
        changed.has("chatLoading") ||
        changed.has("tab"))
    ) {
      this.scheduleChatScroll();
    }
  }

  connect() {
    this.lastError = null;
    this.hello = null;
    this.connected = false;

    this.client?.stop();
    this.client = new GatewayBrowserClient({
      url: this.settings.gatewayUrl,
      token: this.settings.token.trim() ? this.settings.token : undefined,
      username: this.settings.username.trim()
        ? this.settings.username.trim()
        : undefined,
      password: this.password.trim() ? this.password : undefined,
      clientName: "clawdis-control-ui",
      mode: "webchat",
      onHello: (hello) => {
        this.connected = true;
        this.hello = hello;
        this.applySnapshot(hello);
        void this.refreshActiveTab();
      },
      onClose: ({ code, reason }) => {
        this.connected = false;
        this.lastError = `disconnected (${code}): ${reason || "no reason"}`;
      },
      onEvent: (evt) => this.onEvent(evt),
      onGap: ({ expected, received }) => {
        this.lastError = `event gap detected (expected seq ${expected}, got ${received}); refresh recommended`;
      },
    });
    this.client.start();
  }

  private scheduleChatScroll() {
    if (this.chatScrollFrame) cancelAnimationFrame(this.chatScrollFrame);
    this.chatScrollFrame = requestAnimationFrame(() => {
      this.chatScrollFrame = null;
      const container = this.querySelector(".messages") as HTMLElement | null;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    });
  }

  private onEvent(evt: GatewayEventFrame) {
    this.eventLog = [
      { ts: Date.now(), event: evt.event, payload: evt.payload },
      ...this.eventLog,
    ].slice(0, 250);

    if (evt.event === "chat") {
      const state = handleChatEvent(this, evt.payload as unknown);
      if (state === "final") void loadChatHistory(this);
      return;
    }

    if (evt.event === "presence") {
      const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
      if (payload?.presence && Array.isArray(payload.presence)) {
        this.presenceEntries = payload.presence;
        this.presenceError = null;
        this.presenceStatus = null;
      }
      return;
    }

    if (evt.event === "cron" && this.tab === "cron") {
      void this.loadCron();
    }
  }

  private applySnapshot(hello: GatewayHelloOk) {
    const snapshot = hello.snapshot as
      | { presence?: PresenceEntry[]; health?: HealthSnapshot }
      | undefined;
    if (snapshot?.presence && Array.isArray(snapshot.presence)) {
      this.presenceEntries = snapshot.presence;
    }
    if (snapshot?.health) {
      this.debugHealth = snapshot.health;
    }
  }

  applySettings(next: UiSettings) {
    this.settings = next;
    saveSettings(next);
  }

  setTab(next: Tab) {
    this.tab = next;
    void this.refreshActiveTab();
  }

  private async refreshActiveTab() {
    if (this.tab === "overview") await this.loadOverview();
    if (this.tab === "connections") await this.loadConnections();
    if (this.tab === "instances") await loadPresence(this);
    if (this.tab === "sessions") await loadSessions(this);
    if (this.tab === "cron") await this.loadCron();
    if (this.tab === "skills") await loadSkills(this);
    if (this.tab === "nodes") await loadNodes(this);
    if (this.tab === "chat") await loadChatHistory(this);
    if (this.tab === "config") await loadConfig(this);
    if (this.tab === "debug") await loadDebug(this);
  }

  async loadOverview() {
    await Promise.all([
      loadProviders(this, false),
      loadPresence(this),
      loadSessions(this),
      loadCronStatus(this),
      loadDebug(this),
    ]);
  }

  private async loadConnections() {
    await Promise.all([loadProviders(this, true), loadConfig(this)]);
  }

  async loadCron() {
    await Promise.all([loadCronStatus(this), loadCronJobs(this)]);
  }

  async handleSendChat() {
    await sendChat(this);
    void loadChatHistory(this);
  }

  async handleWhatsAppStart(force: boolean) {
    await startWhatsAppLogin(this, force);
    await loadProviders(this, true);
  }

  async handleWhatsAppWait() {
    await waitWhatsAppLogin(this);
    await loadProviders(this, true);
  }

  async handleWhatsAppLogout() {
    await logoutWhatsApp(this);
    await loadProviders(this, true);
  }

  async handleTelegramSave() {
    await saveTelegramConfig(this);
    await loadConfig(this);
    await loadProviders(this, true);
  }

  render() {
    return renderApp(this);
  }
}
