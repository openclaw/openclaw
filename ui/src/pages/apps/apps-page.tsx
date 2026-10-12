import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { titleForRoute } from "../../app-navigation.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { isNativeWebChromeHost } from "../../app/native-web-chrome.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { McpAppCatalog } from "../../components/mcp-app-catalog.tsx";
import type { McpAppOpenDetail } from "../../components/mcp-app-launch.ts";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { mcpAppRouteFromSearch, resolveMcpAppRouteServer } from "../../lib/mcp-app-route.ts";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { useMcpAppCatalog } from "../../lib/reactive/mcp-app-catalog.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { buildMacGatewayLaunchUrl } from "./gateway-launch.ts";
import { Apps } from "./view.tsx";

registerEnglishCatalog(registerMcpAppEnglish);

type AppsPageProps = { appSearch: string };
type AppLaunch = { key: string; detail?: McpAppOpenDetail };

function AppsPageContent(props: AppsPageProps) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const selection = projectAgentSelection(context.agentSelection);
  const appRoute = createMemo(() => mcpAppRouteFromSearch(props.appSearch));
  const catalog = useMcpAppCatalog(
    context,
    () => ({
      sessionKey: appRoute() ? gateway.read().snapshot.sessionKey : "",
      agentId: selection.read().state.selectedId ?? undefined,
    }),
    () => true,
  );
  const [conversationError, setConversationError] = createSignal<string | null>(null, {
    ownedWrite: true,
  });
  const [retry, setRetry] = createSignal(0);
  createEffect(
    () => [appRoute(), retry()] as const,
    ([route]) => {
      if (!route) {
        return undefined;
      }
      let current = true;
      setConversationError(null);
      void ensureCustomElementDefined(
        "openclaw-chat-pane",
        () => import("../chat/route-entry.ts"),
      ).catch((error: unknown) => {
        if (current) {
          setConversationError(formatUiError(error));
        }
      });
      return () => {
        current = false;
      };
    },
  );
  const launch = createMemo((previous: AppLaunch | undefined): AppLaunch => {
    const state = gateway.read();
    const agentId = selection.read().state.selectedId ?? undefined;
    const key = JSON.stringify([
      props.appSearch,
      state.snapshot.sessionKey,
      agentId,
      state.connectionRevision,
    ]);
    const route = appRoute();
    const discovered = catalog();
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
    const search = new URLSearchParams(props.appSearch);
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
    <>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <div>
            <div class="page-title">{titleForRoute("apps")}</div>
          </div>
        </section>
      </ShellLayoutBoundary>
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
        <Show
          when={conversationError()}
          fallback={
            <Show
              when={paneKey()}
              keyed
              fallback={
                <Show
                  when={catalog().loading}
                  fallback={<p role="alert">{catalog().error ?? t("mcpApp.invalidLink")}</p>}
                >
                  <p role="status">{t("mcpApp.loading")}</p>
                </Show>
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
          }
        >
          {(error) => (
            <>
              <p role="alert">{error()}</p>
              <button class="btn" onClick={() => setRetry((value) => value + 1)}>
                {t("mcpApp.retry")}
              </button>
            </>
          )}
        </Show>
      </Show>
    </>
  );
}

export const AppsPage = defineSolidBridge("openclaw-apps-page", AppsPageContent, {
  properties: { appSearch: { default: "", attribute: false } },
});
