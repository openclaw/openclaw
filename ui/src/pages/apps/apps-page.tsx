import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import { isNativeWebChromeHost } from "../../app/native-web-chrome.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { McpAppCatalog } from "../../components/mcp-app-catalog.tsx";
import type { McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
import { McpAppView } from "../../components/mcp-app-view-lazy.ts";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createMcpAppCatalog } from "../../lib/mcp-app-catalog.ts";
import { mcpAppRouteFromSearch, resolveMcpAppRouteServer } from "../../lib/mcp-app-route.ts";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { buildMacGatewayLaunchUrl } from "./gateway-launch.ts";
import { Apps } from "./view.tsx";

registerEnglishCatalog(registerMcpAppEnglish);

const AppsConversation = lazy(() => {
  // Start the app view with the conversation; the panel owns failures and launch admission.
  void McpAppView.preload().catch(() => undefined);
  return import("./apps-conversation.tsx");
});

type AppLaunch = { key: string; detail?: McpAppOpenDetail };

export function AppsPage(props: { appSearch?: string }) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const selection = projectAgentSelection(context.agentSelection);
  const appSearch = createMemo(() => props.appSearch ?? "");
  const appRoute = createMemo(() => mcpAppRouteFromSearch(appSearch()));
  const catalog = createMcpAppCatalog(
    context,
    () => ({
      sessionKey: appRoute() ? gateway.read().snapshot.sessionKey : "",
      agentId: selection.read().state.selectedId ?? undefined,
    }),
    () => true,
  );
  const launch = createMemo((previous: AppLaunch | undefined): AppLaunch => {
    const state = gateway.read();
    const target = catalog.target();
    const key = JSON.stringify([
      appSearch(),
      target.sessionKey,
      target.agentId,
      state.connectionRevision,
    ]);
    const route = appRoute();
    const discovered = catalog.snapshot();
    if (
      previous?.key === key &&
      previous.detail &&
      previous.detail.owner === state.snapshot.client
    ) {
      return previous;
    }
    if (!route) {
      return { key };
    }
    const search = new URLSearchParams(appSearch());
    const settings = search.get("settings") === "1";
    const server = resolveMcpAppRouteServer(discovered.servers, route, settings);
    const entrypoint =
      server?.entrypoints.find(
        (entry) =>
          entry.toolName === route.toolName &&
          (entry.entrypoint.type === "global" ||
            (settings && entry.entrypoint.type === "settings")),
      ) ??
      (settings && server?.settings?.readTool === route.toolName
        ? {
            toolName: server.settings.readTool,
            title: server.label,
            resourceUri: "",
            entrypoint: { type: "settings" as const },
          }
        : undefined);
    return {
      key,
      detail:
        server && entrypoint
          ? {
              ...target,
              owner: state.snapshot.client,
              serverName: server.serverName,
              entrypoint,
              deepLink: route.deepLink,
              settings,
              quickAction: search.get("quickAction") === "1",
            }
          : undefined,
    };
  });
  const canPairDevice = () =>
    gateway.read().snapshot.phase === "connected" &&
    hasOperatorAdminAccess(gateway.read().snapshot.hello?.auth ?? null);
  const macGatewayLaunchUrl = () =>
    gateway.read().snapshot.phase === "connected" && !isNativeWebChromeHost()
      ? buildMacGatewayLaunchUrl(
          gateway.read().connection.gatewayUrl,
          asOptionalRecord(gateway.read().snapshot.hello?.snapshot)?.controlUiIdentityUrl,
        )
      : null;
  return (
    <openclaw-apps-page>
      <HubPageHeader active="apps" wide docsUrl="https://docs.openclaw.ai/platforms" />
      <Show
        when={appRoute()}
        fallback={
          <SettingsWorkspace>
            <McpAppCatalog surface="global" />
            <Apps
              onNavigate={(route) => context.navigate(route)}
              macGatewayLaunchUrl={macGatewayLaunchUrl()}
              onPairDevice={
                canPairDevice() ? () => void context.overlays.openDevicePairSetup() : undefined
              }
            />
          </SettingsWorkspace>
        }
      >
        <button class="btn" onClick={() => context.navigate("apps")}>
          {t("mcpApp.close")}
        </button>
        <Errored
          fallback={(error, reset) => (
            <>
              <p role="alert">{formatUiError(error())}</p>
              <button class="btn" onClick={() => reset()}>
                {t("mcpApp.retry")}
              </button>
            </>
          )}
        >
          <Loading on={appRoute()} fallback={<p role="status">{t("mcpApp.loading")}</p>}>
            <AppsConversation
              launch={launch().detail}
              connectionRevision={gateway.read().connectionRevision}
              request={catalog.request()}
            />
          </Loading>
        </Errored>
      </Show>
    </openclaw-apps-page>
  );
}
