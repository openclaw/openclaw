import { createMemo, createRenderEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import type {
  McpAppSettings,
  McpAppSettingsParams,
} from "../../../../src/shared/mcp-app-extensions.js";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import type { McpAppOpenDetail } from "../mcp-app-launch.ts";
import { McpAppRetirement } from "../mcp-app-retirement.tsx";
import { McpAppSettingsForm } from "./mcp-app-settings.tsx";
import "../../styles/mcp-app-extensions.css";

registerMcpAppEnglish();

type McpAppPanelProps = { launch?: McpAppOpenDetail };
export type McpAppPanelElement = SolidBridgeElement<McpAppPanelProps>;

export function McpAppPanelContent(props: McpAppPanelProps & { host: HTMLElement }) {
  const context = useApplication();
  const host = untrack(() => props.host);
  const gateway = projectGateway(context.gateway);
  const [viewId, setViewId] = createSignal("", { ownedWrite: true });
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal<string | null>(null, { ownedWrite: true });
  const [notice, setNotice] = createSignal("", { ownedWrite: true });
  const [settings, setSettings] = createSignal<McpAppSettings | null>(null, { ownedWrite: true });
  const [values, setValues] = createSignal<McpAppSettings["values"]>({}, { ownedWrite: true });
  let View: (typeof import("../mcp-app-view.tsx"))["McpAppView"] | undefined;
  let generation = 0;
  let mounted = true;
  const launchIdentity = () => {
    const launch = props.launch;
    return JSON.stringify([
      launch?.sessionKey,
      launch?.agentId,
      launch?.serverName,
      launch?.entrypoint.toolName,
      launch?.filePath,
      launch?.settings,
      launch?.quickAction,
    ]);
  };
  onCleanup(() => {
    mounted = false;
    generation++;
  });

  async function operation<T>(
    run: (
      client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>,
      launch: McpAppOpenDetail,
    ) => Promise<T>,
    commit: (result: T) => void,
  ) {
    const launch = props.launch;
    const client = context.gateway.snapshot.client;
    if (
      !launch ||
      !client ||
      client !== launch.owner ||
      context.gateway.snapshot.phase !== "connected"
    ) {
      setError(t("mcpApp.disconnected"));
      return;
    }
    const currentGeneration = ++generation;
    const identity = launchIdentity();
    const scope = gatewayPresentationScope(context.gateway).key;
    const current = () =>
      mounted &&
      host.isConnected &&
      generation === currentGeneration &&
      untrack(launchIdentity) === identity &&
      context.gateway.snapshot.client === client &&
      gatewayPresentationScope(context.gateway).key === scope;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await run(client, launch);
      if (current()) {
        commit(result);
      }
    } catch (failure) {
      if (current()) {
        setError(formatUiError(failure));
      }
    } finally {
      if (current()) {
        setBusy(false);
      }
    }
  }
  function params(
    launch: McpAppOpenDetail,
    action: McpAppSettingsParams["action"],
  ): McpAppSettingsParams {
    return {
      sessionKey: launch.sessionKey,
      agentId: launch.agentId,
      serverName: launch.serverName,
      action,
    };
  }
  function acceptSettings(result: McpAppSettings) {
    setSettings(result);
    setValues({ ...result.values });
  }
  async function readSettings() {
    await operation(
      (client, launch) =>
        client.request<McpAppSettings>("mcp.app.settings", params(launch, "read")),
      acceptSettings,
    );
  }
  async function open() {
    if (props.launch?.settings) {
      await readSettings();
      return;
    }
    await operation(
      async (client, launch) => {
        View = (await import("../mcp-app-view-registration.ts")).McpAppView;
        const currentLaunch = untrack(() => props.launch);
        if (
          currentLaunch?.sessionKey !== launch.sessionKey ||
          currentLaunch?.serverName !== launch.serverName ||
          currentLaunch?.entrypoint.toolName !== launch.entrypoint.toolName ||
          client !== context.gateway.snapshot.client ||
          !mounted ||
          !host.isConnected
        ) {
          throw new Error(t("mcpApp.disconnected"));
        }
        return client.request<{ viewId?: string; toolResult?: { isError?: boolean } }>(
          "mcp.app.launch",
          {
            sessionKey: launch.sessionKey,
            agentId: launch.agentId,
            serverName: launch.serverName,
            toolName: launch.entrypoint.toolName,
            entrypointType: launch.entrypoint.entrypoint.type,
            ...(launch.quickAction ? { quickAction: true } : {}),
            ...(launch.filePath ? { filePath: launch.filePath } : {}),
            ...(launch.deepLink ? { deepLink: launch.deepLink } : {}),
          },
        );
      },
      (result) => {
        if (result.toolResult?.isError || (!result.viewId && !result.toolResult)) {
          throw new Error(t("mcpApp.errors.requestFailed"));
        }
        if (result.viewId) {
          setViewId(result.viewId);
        } else {
          setNotice(t("mcpApp.actionComplete"));
        }
      },
    );
  }
  async function saveSettings() {
    const set = Object.fromEntries(
      Object.entries(values()).filter(([key, value]) => settings()?.values[key] !== value),
    );
    if (!Object.keys(set).length) {
      return;
    }
    await operation(
      async (client, launch) => {
        const result = await client.request<{ toolResult?: { isError?: boolean } }>(
          "mcp.app.settings",
          {
            ...params(launch, "update"),
            arguments: { set },
          },
        );
        if (result.toolResult?.isError) {
          throw new Error(t("mcpApp.errors.requestFailed"));
        }
        return client.request<McpAppSettings>("mcp.app.settings", params(launch, "read"));
      },
      (result) => {
        acceptSettings(result);
        setNotice(t("mcpApp.settingsSaved"));
      },
    );
  }
  async function runTool(toolName: string) {
    await operation(
      async (client, launch) => {
        View = (await import("../mcp-app-view-registration.ts")).McpAppView;
        const currentLaunch = untrack(() => props.launch);
        if (
          currentLaunch !== launch ||
          context.gateway.snapshot.client !== client ||
          !mounted ||
          !host.isConnected
        ) {
          throw new Error(t("mcpApp.disconnected"));
        }
        return client.request<{ viewId?: string; toolResult?: { isError?: boolean } }>(
          "mcp.app.settings",
          { ...params(launch, "tool"), toolName },
        );
      },
      (result) => {
        if (result.toolResult?.isError) {
          setError(t("mcpApp.errors.requestFailed"));
          return;
        }
        if (result.viewId) {
          setSettings(null);
          setViewId(result.viewId);
        } else {
          setNotice(t("mcpApp.actionComplete"));
        }
      },
    );
  }
  const openIdentity = createMemo(() => {
    gateway.read();
    return JSON.stringify([launchIdentity(), gatewayPresentationScope(context.gateway).key]);
  });
  createRenderEffect(openIdentity, () =>
    untrack(() => {
      generation++;
      setViewId("");
      setSettings(null);
      setBusy(false);
      setError(null);
      if (props.launch && props.launch.owner === context.gateway.snapshot.client) {
        void open();
      }
    }),
  );
  return (
    <Show when={props.launch}>
      {(launch) => (
        <section class="mcp-app-panel">
          <div class="mcp-app-panel__toolbar">
            <strong>{launch().entrypoint.title}</strong>
            <span class="muted">{launch().serverName}</span>
            <Show when={launch().settings && !settings()}>
              <button
                class="btn btn--sm"
                disabled={busy()}
                onClick={() => {
                  setViewId("");
                  void readSettings();
                }}
              >
                {t("mcpApp.settings")}
              </button>
            </Show>
          </div>
          <Show when={busy()}>
            <p role="status">{t("mcpApp.loading")}</p>
          </Show>
          <Show when={error()}>
            <p role="alert">{error()}</p>
            <button class="btn" onClick={() => void open()}>
              {t("mcpApp.retry")}
            </button>
          </Show>
          <Show when={notice()}>
            <p role="status">{notice()}</p>
          </Show>
          <Show when={settings()}>
            {(current) => (
              <McpAppSettingsForm
                settings={current()}
                values={values()}
                busy={busy()}
                onChange={(key, value) => setValues((old) => ({ ...old, [key]: value }))}
                onSave={() => void saveSettings()}
                onTool={(name) => void runTool(name)}
              />
            )}
          </Show>
          <McpAppRetirement identity={viewId()} roots={() => [host]}>
            {(id) => {
              const acceptedLaunch = untrack(launch);
              const acceptedIdentity = untrack(launchIdentity);
              const viewLaunch = createMemo<McpAppOpenDetail>((previous) => {
                const current = launch();
                return launchIdentity() === acceptedIdentity &&
                  current.owner === acceptedLaunch.owner
                  ? current
                  : (previous ?? acceptedLaunch);
              });
              const LoadedView = View;
              return id && LoadedView ? (
                <LoadedView
                  sessionKey={viewLaunch().sessionKey}
                  agentId={viewLaunch().agentId ?? ""}
                  viewId={id}
                  title={viewLaunch().entrypoint.title}
                  deepLink={viewLaunch().deepLink}
                  onRelaunch={() => void open()}
                  relaunching={busy()}
                />
              ) : undefined;
            }}
          </McpAppRetirement>
        </section>
      )}
    </Show>
  );
}

export const McpAppPanel = defineSolidBridge<McpAppPanelProps>(
  "openclaw-mcp-app-panel",
  (props, host) => <McpAppPanelContent {...props} host={host} />,
  { properties: { launch: { default: undefined, attribute: false } } },
);
