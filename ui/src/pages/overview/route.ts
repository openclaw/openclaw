import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import type { RouteRenderContext } from "../../app-routes.ts";
import type { SettingsHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import { warnQueryToken } from "../../ui/app-settings.ts";
import { loadOverview } from "./data.ts";
import { renderOverview } from "./view.ts";

type OverviewRenderContext = RouteRenderContext;
type OverviewLoadContext = { host: SettingsHost };

export const page = definePage({
  id: "overview",
  path: "/overview",
  loader: ({ host }: OverviewLoadContext, options) => loadOverview(host, undefined, options),
  component: () => ({
    header: true,
    render: ({ state, navigate }: OverviewRenderContext) => html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("overview")}</div>
          <div class="page-sub">${subtitleForRoute("overview")}</div>
        </div>
      </section>
      ${renderOverview({
        connected: state.connected,
        hello: state.hello,
        settings: state.settings,
        password: state.password,
        lastError: state.lastError,
        lastErrorCode: state.lastErrorCode,
        presenceCount: state.presenceEntries.length,
        sessionsCount: state.sessionsResult?.count ?? null,
        cronEnabled: state.cronStatus?.enabled ?? null,
        cronNext: state.cronStatus?.nextWakeAtMs ?? null,
        lastChannelsRefresh: state.channelsLastSuccess,
        warnQueryToken,
        modelAuthStatus: state.modelAuthStatusResult,
        usageResult: state.usageResult,
        sessionsResult: state.sessionsResult,
        skillsReport: state.skillsReport,
        cronJobs: state.cronJobs,
        cronStatus: state.cronStatus,
        attentionItems: state.attentionItems,
        eventLog: state.eventLog,
        overviewLogLines: state.overviewLogLines,
        showGatewayToken: state.overviewShowGatewayToken,
        showGatewayPassword: state.overviewShowGatewayPassword,
        onSettingsChange: (next) => state.applySettings(next),
        onPasswordChange: (next) => (state.password = next),
        onSessionKeyChange: (sessionKey) => {
          state.applySettings({
            ...state.settings,
            sessionKey,
            lastActiveSessionKey: sessionKey,
          });
        },
        onToggleGatewayTokenVisibility: () => {
          state.overviewShowGatewayToken = !state.overviewShowGatewayToken;
        },
        onToggleGatewayPasswordVisibility: () => {
          state.overviewShowGatewayPassword = !state.overviewShowGatewayPassword;
        },
        onConnect: () => state.connect(),
        onRefresh: () => void state.loadOverview({ refresh: true }),
        onNavigate: navigate,
        onRefreshLogs: () => void state.loadOverview({ refresh: true }),
      })}
    `,
  }),
});
