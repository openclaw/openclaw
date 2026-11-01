import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  For,
  lazy,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { isQuestionThumbnail } from "../../../packages/gateway-protocol/src/question-media.js";
import type {
  McpAppDiscoveredEntrypoint,
  McpAppDiscoveredServer,
} from "../../../src/shared/mcp-app-extensions.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { UserFacingError } from "../lib/format-error.ts";
import type { createMcpAppCatalog } from "../lib/mcp-app-catalog.ts";
import { mcpAppRouteSearch } from "../lib/mcp-app-route.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { generateUUID } from "../lib/uuid.ts";
import { requestMcpAppOpen } from "./mcp-app-launch.ts";
import { Icon } from "./solid/icon.tsx";
import { McpAppOperationError } from "./solid/mcp-app-operation-error.tsx";

const DiscoveryStatus = lazy(() => import("./mcp-app-discovery-status.tsx"));

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

export function McpAppCatalogView(props: {
  surface?: "global" | "thread" | "sidebar" | "file";
  filePath?: string;
  host: () => HTMLElement;
  catalog: ReturnType<typeof createMcpAppCatalog>;
  visible: boolean;
  rows: { server: McpAppDiscoveredServer; entry: McpAppDiscoveredEntrypoint }[];
  entries: (server: McpAppDiscoveredServer) => McpAppDiscoveredEntrypoint[];
}) {
  const surface = () => props.surface ?? "global";
  const context = useApplication();
  const [expanded, setExpanded] = createSignal(false);
  const [operation, setOperation] = createSignal<{
    current: () => boolean;
    result: Promise<null>;
  }>();
  const [onboardingBusy, setOnboardingBusy] = createOptimistic(false);
  let active = true;
  // Admission stays synchronous; the optimistic flag only drives presentation.
  let onboardingPending = false;
  onSettled(() => () => {
    active = false;
  });
  function captureOperation() {
    const client = context.gateway.snapshot.client;
    const initialTarget = props.catalog.target();
    const scope = gatewayPresentationScope(context.gateway).key;
    return {
      client,
      selected: initialTarget,
      current: () => {
        const destination = props.catalog.target();
        return (
          active &&
          context.gateway.snapshot.client === client &&
          gatewayPresentationScope(context.gateway).key === scope &&
          destination.sessionKey === initialTarget.sessionKey &&
          destination.agentId === initialTarget.agentId
        );
      },
    };
  }
  const currentOperation = () => {
    // The catalog's identity tracks connection and selection changes.
    props.catalog.snapshot();
    const admitted = operation();
    return admitted?.current() ? admitted : undefined;
  };
  function recordOutcome(current: () => boolean, result: Promise<unknown>) {
    const completion = result.then(() => null);
    // The alert may be collapsed or retired before its admitted work settles.
    void completion.catch(() => {});
    setOperation({ current, result: completion });
  }
  const compact = () => surface() === "thread" || surface() === "file";
  function open(
    server: McpAppDiscoveredServer,
    entrypoint: McpAppDiscoveredEntrypoint,
    settings = false,
    quickAction = false,
  ) {
    if (!props.catalog.available()) {
      return;
    }
    setOperation(undefined);
    if (surface() === "sidebar" || surface() === "global") {
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
      requestMcpAppOpen(props.host(), {
        ...props.catalog.target(),
        owner: context.gateway.snapshot.client,
        serverName: server.serverName,
        entrypoint,
        settings,
        quickAction,
        ...(surface() === "file" ? { filePath: props.filePath ?? "" } : {}),
      })
    ) {
      setExpanded(false);
    } else {
      recordOutcome(
        captureOperation().current,
        Promise.reject(new UserFacingError(t("mcpApp.errors.mountUnavailable"))),
      );
    }
  }
  const performOnboarding = action(function* (pending: Promise<void>) {
    setOnboardingBusy(true);
    yield pending;
  });
  async function onboard(pluginId: string) {
    const { client, selected, current } = captureOperation();
    if (!client || !props.catalog.available() || onboardingPending) {
      return;
    }
    onboardingPending = true;
    const pending = (async () => {
      await client.request("mcp.app.onboard", {
        ...selected,
        pluginId,
        idempotencyKey: generateUUID(),
      });
    })();
    recordOutcome(current, pending);
    try {
      await performOnboarding(pending);
      // Read the current target after the action releases its held presentation.
      if (!current()) {
        return;
      }
      const route = sessionNavigationTarget({
        context,
        sessionKey: selected.sessionKey,
        agentId: selected.agentId,
        face: "chat",
      });
      context.navigate("chat", route.options);
    } catch {
      // The scoped outcome boundary consumes the admitted rejection.
    } finally {
      onboardingPending = false;
    }
  }
  return (
    <Show when={props.visible}>
      <Show
        when={surface() === "sidebar"}
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
                {t(surface() === "file" ? "mcpApp.openWith" : "mcpApp.threadApps")}
              </button>
            </Show>
            <Show when={!compact() || expanded()}>
              <div class="mcp-app-catalog__entries">
                <Loading fallback={<p role="status">{t("mcpApp.loading")}</p>}>
                  <DiscoveryStatus
                    request={props.catalog.request()}
                    emptyMessage={!props.rows.length ? t("mcpApp.empty") : undefined}
                    onRetry={() => void props.catalog.refresh()}
                    retryDisabled={!props.catalog.available()}
                  />
                  <For
                    each={props.rows}
                    keyed={(row) => JSON.stringify([row.server.serverName, row.entry.toolName])}
                  >
                    {(row) => {
                      const quickAction = createMemo(() => {
                        const entrypoint = row().entry.entrypoint;
                        return entrypoint.type === "global" && entrypoint.quickAction;
                      });
                      return (
                        <div class="mcp-app-catalog__entry">
                          <button
                            class="btn"
                            type="button"
                            disabled={!props.catalog.available()}
                            onClick={() => open(row().server, row().entry)}
                          >
                            <CatalogIcon server={row().server} entry={row().entry} />
                            <span>
                              <strong>{row().entry.title}</strong>
                              <small>{row().server.label}</small>
                            </span>
                          </button>
                          <Show when={quickAction()}>
                            {(shortcut) => (
                              <button
                                class="btn btn--sm"
                                type="button"
                                disabled={!props.catalog.available()}
                                onClick={() => open(row().server, row().entry, false, true)}
                              >
                                {shortcut().title}
                              </button>
                            )}
                          </Show>
                          <Show when={row().server.settings}>
                            <button
                              type="button"
                              class="btn btn--sm"
                              aria-label={`${t("mcpApp.settings")}: ${row().entry.title}`}
                              disabled={!props.catalog.available()}
                              onClick={() => open(row().server, row().entry, true)}
                            >
                              {t("mcpApp.settings")}
                            </button>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                  <Show when={surface() !== "file"}>
                    <For
                      each={props.catalog
                        .snapshot()
                        .servers.filter(
                          (server) => server.settings && !props.entries(server).length,
                        )}
                    >
                      {(server) => (
                        <button
                          class="btn"
                          type="button"
                          disabled={!props.catalog.available()}
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
                  <For each={props.catalog.snapshot().onboarding}>
                    {(plugin) => (
                      <button
                        class="btn"
                        type="button"
                        disabled={onboardingBusy() || !props.catalog.available()}
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
                </Loading>
              </div>
            </Show>
            <Show when={currentOperation()} keyed>
              {(admitted) => <McpAppOperationError result={admitted.result} />}
            </Show>
          </section>
        }
      >
        <For
          each={props.rows}
          keyed={(row) => JSON.stringify([row.server.serverName, row.entry.toolName])}
        >
          {(row) => (
            <button
              type="button"
              class="nav-item"
              disabled={!props.catalog.available()}
              onClick={() => open(row().server, row().entry)}
              title={row().server.label}
            >
              <span class="nav-item__icon">
                <CatalogIcon server={row().server} entry={row().entry} />
              </span>
              <span class="nav-item__text">{row().entry.title}</span>
            </button>
          )}
        </For>
      </Show>
    </Show>
  );
}
