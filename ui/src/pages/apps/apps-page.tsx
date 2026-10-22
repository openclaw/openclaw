import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { isNativeWebChromeHost } from "../../app/native-web-chrome.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { McpAppCatalog } from "../../components/mcp-app-catalog.tsx";
import type { McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
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

const DiscoveryStatus = lazy(() => import("../../components/mcp-app-discovery-status.tsx"));

type AppsPageProps = { appSearch?: string };
type AppLaunch = { key: string; detail?: McpAppOpenDetail };

export function AppsPage(props: AppsPageProps) {
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
  const conversationReady = createMemo(async () => {
    if (appRoute()) {
      await ensureCustomElementDefined(
        "openclaw-chat-pane",
        () => import("../chat/route-entry.ts"),
      );
    }
    return null;
  });
  const launch = createMemo((previous: AppLaunch | undefined): AppLaunch => {
    const state = gateway.read();
    const agentId = selection.read().state.selectedId ?? undefined;
    const key = JSON.stringify([
      appSearch(),
      state.snapshot.sessionKey,
      agentId,
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
              sessionKey: state.snapshot.sessionKey,
              agentId,
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
  const paneKey = () =>
    launch().detail
      ? JSON.stringify([launch().detail?.sessionKey, gateway.read().connectionRevision])
      : "";
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
            {conversationReady()}
            <Show
              when={paneKey()}
              keyed
              fallback={
                <Loading fallback={<p role="status">{t("mcpApp.loading")}</p>}>
                  <DiscoveryStatus
                    request={catalog.request()}
                    emptyMessage={t("mcpApp.invalidLink")}
                    emptyRole="alert"
                  />
                </Loading>
              }
            >
              <openclaw-chat-pane
                class="mcp-app-conversation"
                prop:sessionKey={launch().detail!.sessionKey}
                prop:agentId={launch().detail!.agentId}
                prop:paneId="plugin-app"
                prop:presentationId={`plugin-app:${launch().detail!.sessionKey}`}
                prop:mcpAppLaunch={launch().detail}
              />
            </Show>
          </Loading>
        </Errored>
      </Show>
    </openclaw-apps-page>
  );
}
