import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AttentionItem,
  ModelAuthStatusResult,
  SessionsUsageResult,
  SkillStatusReport,
} from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { isRouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import {
  loadGatewaySessionSelection,
  loadSettings,
  patchSettings,
  type UiSettings,
} from "../../app/settings.ts";
import { I18nController, t } from "../../i18n/index.ts";
import { isCronJobActiveFailure } from "../../lib/cron-status.ts";
import { createInitialCronState, loadCronJobsPage, loadCronStatus } from "../../lib/cron/index.ts";
import { isMonitoredAuthProvider, loadModelAuthStatus } from "../../lib/model-auth.ts";
import { requestSessionUsage } from "../../lib/sessions/index.ts";
import { loadSkillStatusReport } from "../../lib/skills/index.ts";
import { renderOverview } from "./view.ts";

function localDateString(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function hasMissingSkillDependencies(missing: Record<string, unknown> | null | undefined): boolean {
  return Boolean(
    missing && Object.values(missing).some((value) => Array.isArray(value) && value.length > 0),
  );
}

function addNamedAttention(
  items: AttentionItem[],
  entries: readonly { name: string }[],
  severity: AttentionItem["severity"],
  icon: AttentionItem["icon"],
  title: string,
) {
  if (entries.length > 0) {
    items.push({
      severity,
      icon,
      title,
      description: entries.map((entry) => entry.name).join(", "),
    });
  }
}

class OverviewPage extends LitElement {
  readonly i18nController = new I18nController(this);

  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private settings: UiSettings = loadSettings();
  @state() private password = "";
  @state() private showGatewayToken = false;
  @state() private showGatewayPassword = false;
  @state() private cron = createInitialCronState();
  @state() private usageResult: SessionsUsageResult | null = null;
  @state() private skillsReport: SkillStatusReport | null = null;
  @state() private modelAuthStatus: ModelAuthStatusResult | null = null;
  @state() private overviewLogLines: string[] = [];

  private overviewLogCursor: number | null = null;
  private refreshPromise: Promise<void> | null = null;
  private subscriptions: Array<() => void> = [];
  private sessionKeyDirty = false;

  override connectedCallback() {
    super.connectedCallback();
    this.resetServerState();
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => {
        if (this.cron.client !== snapshot.client) {
          this.resetServerState();
        }
        this.requestUpdate();
        this.ensureInitialData();
      }),
      this.context.channels.subscribe(() => this.requestUpdate()),
      this.context.sessions.subscribe(() => this.requestUpdate()),
      this.context.gateway.subscribeEventLog(() => this.requestUpdate()),
    ];
    this.ensureInitialData();
  }

  override disconnectedCallback() {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.refreshPromise = null;
    super.disconnectedCallback();
  }

  private resetServerState() {
    const gateway = this.context.gateway;
    const sessionKey = gateway.snapshot.sessionKey;
    this.settings = {
      ...loadSettings(),
      gatewayUrl: gateway.connection.gatewayUrl,
      token: gateway.connection.token,
      sessionKey,
      lastActiveSessionKey: sessionKey,
    };
    this.password = gateway.connection.password;
    this.cron = createInitialCronState(gateway.snapshot);
    this.usageResult = null;
    this.skillsReport = null;
    this.modelAuthStatus = null;
    this.overviewLogLines = [];
    this.overviewLogCursor = null;
    this.refreshPromise = null;
    this.sessionKeyDirty = false;
  }

  private ensureInitialData() {
    const gateway = this.context.gateway.snapshot;
    if (!gateway.connected || !gateway.client || this.refreshPromise) {
      return;
    }
    void this.refreshOverview(false);
  }

  private isCurrentClient(client: GatewayBrowserClient): boolean {
    const gateway = this.context.gateway.snapshot;
    return gateway.connected && gateway.client === client && this.isConnected;
  }

  private async applyRequest<T>(
    client: GatewayBrowserClient,
    request: Promise<T>,
    apply: (value: T) => void,
  ) {
    const value = await request;
    if (this.isCurrentClient(client)) {
      apply(value);
    }
  }

  private async refreshOverview(force: boolean) {
    const context = this.context;
    const client = context.gateway.snapshot.client;
    if (!client || !context.gateway.snapshot.connected || this.refreshPromise) {
      return;
    }

    const channelRefresh =
      force || !context.channels.state.channelsSnapshot
        ? context.channels.refresh(false)
        : Promise.resolve();
    const date = localDateString();
    const cron = createInitialCronState({ client, connected: true });
    const refresh = Promise.allSettled([
      channelRefresh,
      context.sessions.refresh(force ? { force: true } : undefined),
      Promise.all([loadCronStatus(cron), loadCronJobsPage(cron)]).then(() => {
        if (this.isCurrentClient(client)) {
          this.cron = cron;
        }
      }),
      this.applyRequest(
        client,
        requestSessionUsage(client, {
          startDate: date,
          endDate: date,
          scope: "family",
          timeZone: "local",
        }),
        (result) => (this.usageResult = result),
      ),
      this.applyRequest(client, loadSkillStatusReport(client, null), (report) => {
        this.skillsReport = report ?? null;
      }),
      this.applyRequest(
        client,
        loadModelAuthStatus(client, { refresh: force }).catch(() => ({
          ts: 0,
          providers: [],
        })),
        (result) => (this.modelAuthStatus = result),
      ),
      this.loadLogs(client),
    ]).then(() => undefined);
    this.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshPromise === refresh) {
        this.refreshPromise = null;
      }
    }
  }

  private async loadLogs(client: GatewayBrowserClient) {
    try {
      const response = await client.request<{
        cursor?: number;
        lines?: unknown;
        reset?: boolean;
      }>("logs.tail", {
        cursor: this.overviewLogCursor ?? undefined,
        limit: 100,
        maxBytes: 50_000,
      });
      if (!this.isCurrentClient(client)) {
        return;
      }
      const lines = Array.isArray(response.lines)
        ? response.lines.filter((line): line is string => typeof line === "string")
        : [];
      this.overviewLogLines = (response.reset ? lines : [...this.overviewLogLines, ...lines]).slice(
        -500,
      );
      if (typeof response.cursor === "number") {
        this.overviewLogCursor = response.cursor;
      }
    } catch {
      // The log tail is optional dashboard context.
    }
  }

  private updateConnectionDraft(patch: Partial<Pick<UiSettings, "gatewayUrl" | "token">>) {
    this.settings = { ...this.settings, ...patch };
  }

  private updateLocale(locale: string) {
    const gateway = this.context.gateway;
    const navigation = this.context.navigation.snapshot;
    const nextDraft = {
      ...this.settings,
      themeMode: this.context.theme.mode,
      navCollapsed: navigation.navCollapsed,
      sidebarPinnedRoutes: [...navigation.sidebarPinnedRoutes],
      sidebarMoreExpanded: navigation.sidebarMoreExpanded,
      locale,
    };
    this.settings = nextDraft;
    patchSettings({
      gatewayUrl: gateway.connection.gatewayUrl,
      token: gateway.connection.token,
      sessionKey: gateway.snapshot.sessionKey,
      lastActiveSessionKey: gateway.snapshot.sessionKey,
      locale,
    });
  }

  private connect() {
    const session = this.sessionKeyDirty
      ? {
          sessionKey: this.settings.sessionKey,
          lastActiveSessionKey: this.settings.sessionKey,
        }
      : loadGatewaySessionSelection(this.settings.gatewayUrl);
    this.settings = { ...this.settings, ...session };
    this.sessionKeyDirty = false;
    this.context.gateway.connect({
      gatewayUrl: this.settings.gatewayUrl,
      token: this.settings.token,
      password: this.password,
      sessionKey: session.sessionKey,
    });
  }

  private buildAttentionItems(): AttentionItem[] {
    const gateway = this.context.gateway.snapshot;
    const items: AttentionItem[] = [];
    if (gateway.lastError) {
      items.push({
        severity: "error",
        icon: "x",
        title: "Gateway Error",
        description: gateway.lastError,
      });
    }

    const auth = gateway.hello?.auth ?? null;
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

    const skills = this.skillsReport?.skills ?? [];
    const missingDeps = skills.filter(
      (skill) => !skill.disabled && hasMissingSkillDependencies(skill.missing),
    );
    if (missingDeps.length > 0) {
      const names = missingDeps.slice(0, 3).map((skill) => skill.name);
      const more = missingDeps.length > 3 ? ` +${missingDeps.length - 3} more` : "";
      items.push({
        severity: "warning",
        icon: "zap",
        title: "Skills with missing dependencies",
        description: `${names.join(", ")}${more}`,
      });
    }

    const blocked = skills.filter((skill) => skill.blockedByAllowlist);
    addNamedAttention(
      items,
      blocked,
      "warning",
      "shield",
      `${blocked.length} skill${blocked.length === 1 ? "" : "s"} blocked`,
    );

    const failedCron = this.cron.cronJobs.filter(isCronJobActiveFailure);
    addNamedAttention(
      items,
      failedCron,
      "error",
      "clock",
      `${failedCron.length} cron job${failedCron.length === 1 ? "" : "s"} failed`,
    );

    const now = Date.now();
    const overdue = this.cron.cronJobs.filter(
      (job) =>
        job.enabled && job.state?.nextRunAtMs != null && now - job.state.nextRunAtMs > 300_000,
    );
    addNamedAttention(
      items,
      overdue,
      "warning",
      "clock",
      `${overdue.length} overdue job${overdue.length === 1 ? "" : "s"}`,
    );

    const monitored = (this.modelAuthStatus?.providers ?? []).filter(isMonitoredAuthProvider);
    const expiredProviders = monitored.filter(
      (provider) => provider.status === "expired" || provider.status === "missing",
    );
    if (expiredProviders.length > 0) {
      items.push({
        severity: "error",
        icon: "key",
        title: t("overview.cards.modelAuthAttentionExpiredTitle"),
        description: t("overview.cards.modelAuthAttentionExpiredDesc", {
          providers: expiredProviders.map((provider) => provider.displayName).join(", "),
        }),
      });
    }
    const expiringProviders = monitored.filter((provider) => provider.status === "expiring");
    if (expiringProviders.length > 0) {
      items.push({
        severity: "warning",
        icon: "key",
        title: t("overview.cards.modelAuthAttentionExpiringTitle"),
        description: expiringProviders
          .map((provider) =>
            t("overview.cards.modelAuthAttentionExpiringEntry", {
              provider: provider.displayName,
              when: provider.expiry?.label ?? "soon",
            }),
          )
          .join(", "),
      });
    }
    return items;
  }

  override render() {
    const gateway = this.context.gateway.snapshot;
    const channels = this.context.channels.state;
    const sessions = this.context.sessions.state;
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("overview")}</div>
          <div class="page-sub">${subtitleForRoute("overview")}</div>
        </div>
      </section>
      ${renderOverview({
        connected: gateway.connected,
        hello: gateway.hello,
        settings: this.settings,
        password: this.password,
        lastError: gateway.lastError,
        lastChannelsRefresh: channels.channelsLastSuccess,
        modelAuthStatus: this.modelAuthStatus,
        usageResult: this.usageResult,
        sessionsResult: sessions.result,
        skillsReport: this.skillsReport,
        cronJobs: this.cron.cronJobs,
        cronStatus: this.cron.cronStatus,
        attentionItems: this.buildAttentionItems(),
        eventLog: this.context.gateway.eventLog,
        overviewLogLines: this.overviewLogLines,
        showGatewayToken: this.showGatewayToken,
        showGatewayPassword: this.showGatewayPassword,
        onConnectionChange: (patch) => this.updateConnectionDraft(patch),
        onLocaleChange: (locale) => this.updateLocale(locale),
        onPasswordChange: (next) => (this.password = next),
        onSessionKeyChange: (sessionKey) => {
          this.sessionKeyDirty = true;
          this.settings = {
            ...this.settings,
            sessionKey,
            lastActiveSessionKey: sessionKey,
          };
        },
        onToggleGatewayTokenVisibility: () => {
          this.showGatewayToken = !this.showGatewayToken;
        },
        onToggleGatewayPasswordVisibility: () => {
          this.showGatewayPassword = !this.showGatewayPassword;
        },
        onConnect: () => this.connect(),
        onRefresh: () => void this.refreshOverview(true),
        onNavigate: (routeId) => {
          if (isRouteId(routeId)) {
            this.context.navigate(routeId);
          }
        },
        canNavigate: isRouteId,
        onRefreshLogs: () => void this.refreshOverview(true),
      })}
    `;
  }
}

if (!customElements.get("openclaw-overview-page")) {
  customElements.define("openclaw-overview-page", OverviewPage);
}
