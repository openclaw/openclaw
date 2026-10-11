import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { isQuestionThumbnail } from "../../../packages/gateway-protocol/src/question-media.js";
import type {
  McpAppDiscoveredEntrypoint,
  McpAppDiscoveredServer,
} from "../../../src/shared/mcp-app-extensions.js";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import { mcpAppRouteSearch } from "../lib/mcp-app-route.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { useMcpAppCatalog } from "../lib/reactive/mcp-app-catalog.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { generateUUID } from "../lib/uuid.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { requestMcpAppOpen } from "./mcp-app-launch.ts";
import { Icon } from "./solid/icon.tsx";
import "../styles/mcp-app-extensions.css";

registerMcpAppEnglish();

type McpAppCatalogProps = {
  sessionKey: string;
  agentId: string;
  surface: "global" | "thread" | "sidebar" | "file";
  filePath: string;
};
export type McpAppCatalogElement = SolidBridgeElement<McpAppCatalogProps>;

function CatalogIcon(props: { server: McpAppDiscoveredServer; entry: McpAppDiscoveredEntrypoint }) {
  const icon = () =>
    [...(props.entry.icons ?? []), ...(props.server.icons ?? [])].find(
      (candidate) =>
        (!candidate.theme || candidate.theme === document.documentElement.dataset.themeMode) &&
        isQuestionThumbnail(candidate.src),
    );
  return (
    <Show when={icon()} fallback={<Icon name="puzzle" />}>
      {(image) => (
        <img class="mcp-app-icon" src={image().src} alt="" referrerpolicy="no-referrer" />
      )}
    </Show>
  );
}

function McpAppCatalogContent(props: McpAppCatalogProps & { host: HTMLElement }) {
  const context = useApplication();
  const [expanded, setExpanded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [onboardingRevision, setOnboardingRevision] = createSignal(0, { ownedWrite: true });
  let active = true;
  let onboardingPending = false;
  const onboardingBusy = () => {
    onboardingRevision();
    return onboardingPending;
  };
  onCleanup(() => {
    active = false;
  });
  const target = () => ({
    sessionKey: props.sessionKey || context.gateway.snapshot.sessionKey || "",
    agentId: props.agentId || context.agentSelection.state.selectedId || undefined,
  });
  const catalog = useMcpAppCatalog(context, target, () => props.surface === "global");
  const entries = (server: McpAppDiscoveredServer) =>
    server.entrypoints.filter(({ entrypoint }) =>
      props.surface === "file"
        ? entrypoint.type === "file" &&
          entrypoint.extensions.some((extension) =>
            props.filePath.toLowerCase().endsWith(extension.toLowerCase()),
          )
        : entrypoint.type === (props.surface === "sidebar" ? "global" : props.surface),
    );
  const rows = createMemo(() =>
    catalog().servers.flatMap((server) => entries(server).map((entry) => ({ server, entry }))),
  );
  const compact = () => props.surface === "thread" || props.surface === "file";
  const visible = () =>
    catalog().available &&
    !(props.surface === "file" && !rows().length) &&
    !(
      props.surface === "thread" &&
      !rows().length &&
      !catalog().onboarding.length &&
      !catalog().servers.some((server) => server.settings)
    );
  function open(
    server: McpAppDiscoveredServer,
    entrypoint: McpAppDiscoveredEntrypoint,
    settings = false,
    quickAction = false,
  ) {
    setError(null);
    if (props.surface === "sidebar" || props.surface === "global") {
      const search = mcpAppRouteSearch({
        kind: "server",
        serverName: server.serverName,
        toolName: entrypoint.toolName,
        deepLink: "/",
      });
      context.navigate("apps", {
        search: `${search}${settings ? "&settings=1" : ""}${quickAction ? "&quickAction=1" : ""}`,
      });
    } else if (
      requestMcpAppOpen(props.host, {
        ...target(),
        owner: context.gateway.snapshot.client,
        serverName: server.serverName,
        entrypoint,
        settings,
        quickAction,
        ...(props.surface === "file" ? { filePath: props.filePath } : {}),
      })
    ) {
      setExpanded(false);
    } else {
      setError(t("mcpApp.errors.mountUnavailable"));
    }
  }
  async function onboard(pluginId: string) {
    const client = context.gateway.snapshot.client;
    if (!client || onboardingPending) {
      return;
    }
    const selected = target();
    onboardingPending = true;
    setOnboardingRevision((value) => value + 1);
    try {
      await client.request("mcp.app.onboard", {
        ...selected,
        pluginId,
        idempotencyKey: generateUUID(),
      });
      if (!active || context.gateway.snapshot.client !== client) {
        return;
      }
      const route = sessionNavigationTarget({
        context,
        sessionKey: selected.sessionKey,
        agentId: selected.agentId,
        face: "chat",
      });
      context.navigate("chat", route.options);
    } catch (failure) {
      if (active && context.gateway.snapshot.client === client) {
        setError(formatUiError(failure));
      }
    } finally {
      onboardingPending = false;
      if (active) {
        setOnboardingRevision((value) => value + 1);
      }
    }
  }
  return (
    <Show when={visible()}>
      <Show
        when={props.surface === "sidebar"}
        fallback={
          <section class={["mcp-app-catalog", { "mcp-app-catalog--compact": compact() }]}>
            <Show
              when={compact()}
              fallback={
                <>
                  <h2>{t("mcpApp.catalogTitle")}</h2>
                  <p class="muted">{t("mcpApp.catalogDescription")}</p>
                </>
              }
            >
              <button
                class="btn btn--sm"
                type="button"
                aria-expanded={expanded() ? "true" : "false"}
                onClick={() => setExpanded(!expanded())}
              >
                <Icon name="puzzle" />
                {t(props.surface === "file" ? "mcpApp.openWith" : "mcpApp.threadApps")}
              </button>
            </Show>
            <Show when={!compact() || expanded()}>
              <div class="mcp-app-catalog__entries">
                <Show when={catalog().loading}>
                  <p role="status">{t("mcpApp.loading")}</p>
                </Show>
                <Show when={catalog().error}>
                  <p role="alert">{catalog().error}</p>
                  <button class="btn" onClick={() => void catalog().refresh()}>
                    {t("mcpApp.retry")}
                  </button>
                </Show>
                <Show when={!catalog().loading && !catalog().error && !rows().length}>
                  <p>{t("mcpApp.empty")}</p>
                </Show>
                <For each={rows()}>
                  {({ server, entry }) => (
                    <div class="mcp-app-catalog__entry">
                      <button class="btn" type="button" onClick={() => open(server, entry)}>
                        <CatalogIcon server={server} entry={entry} />
                        <span>
                          <strong>{entry.title}</strong>
                          <small>{server.label}</small>
                        </span>
                      </button>
                      <Show
                        when={entry.entrypoint.type === "global" && entry.entrypoint.quickAction}
                      >
                        {(quickAction) => (
                          <button
                            class="btn btn--sm"
                            type="button"
                            onClick={() => open(server, entry, false, true)}
                          >
                            {quickAction().title}
                          </button>
                        )}
                      </Show>
                      <Show when={server.settings}>
                        <button
                          type="button"
                          class="btn btn--sm"
                          onClick={() => open(server, entry, true)}
                        >
                          {t("mcpApp.settings")}
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={props.surface !== "file"}>
                  <For
                    each={catalog().servers.filter(
                      (server) => server.settings && !entries(server).length,
                    )}
                  >
                    {(server) => (
                      <button
                        class="btn"
                        type="button"
                        onClick={() =>
                          open(
                            server,
                            {
                              toolName: server.settings!.readTool,
                              title: server.label,
                              resourceUri: "",
                              entrypoint: { type: "settings" },
                            },
                            true,
                          )
                        }
                      >
                        {server.label} · {t("mcpApp.settings")}
                      </button>
                    )}
                  </For>
                </Show>
                <For each={catalog().onboarding}>
                  {(plugin) => (
                    <button
                      class="btn"
                      type="button"
                      disabled={onboardingBusy()}
                      onClick={() => void onboard(plugin.pluginId)}
                    >
                      {t("mcpApp.onboarding")} · {plugin.title}
                    </button>
                  )}
                </For>
                <Show when={!compact()}>
                  <button class="btn btn--sm" onClick={() => context.navigate("mcp")}>
                    {t("mcpApp.configure")}
                  </button>
                </Show>
              </div>
            </Show>
            <Show when={error()}>
              <p role="alert">{error()}</p>
            </Show>
          </section>
        }
      >
        <For each={rows()}>
          {({ server, entry }) => (
            <button
              type="button"
              class="nav-item"
              onClick={() => open(server, entry)}
              title={server.label}
            >
              <span class="nav-item__icon">
                <CatalogIcon server={server} entry={entry} />
              </span>
              <span class="nav-item__text">{entry.title}</span>
            </button>
          )}
        </For>
      </Show>
    </Show>
  );
}

export const McpAppCatalog = defineSolidBridge<McpAppCatalogProps>(
  "openclaw-mcp-app-catalog",
  (props, host) => <McpAppCatalogContent {...props} host={host} />,
  {
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "", attribute: false },
      surface: { default: "global" },
      filePath: { default: "", attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-app-catalog": McpAppCatalogElement;
  }
}
