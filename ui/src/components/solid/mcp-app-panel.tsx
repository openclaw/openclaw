import {
  action,
  createEffect,
  createMemo,
  createSignal,
  createOptimistic,
  Errored,
  latest,
  lazy,
  Loading,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import type {
  McpAppSettings,
  McpAppSettingsParams,
} from "../../../../src/shared/mcp-app-extensions.js";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { formatUiError, UserFacingError } from "../../lib/format-error.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { McpAppOpenDetail, McpAppPanelRetirement } from "../mcp-app-launch.ts";
import { McpAppRetirement } from "../mcp-app-retirement.tsx";
import { McpAppSettingsForm } from "./mcp-app-settings.tsx";
import "../../styles/mcp-app-extensions.css";

registerMcpAppEnglish();

const McpAppView = lazy(() => import("../mcp-app-view-registration.ts"), {
  export: "McpAppView",
});

type McpAppPanelProps = { launch?: McpAppOpenDetail; observeRetirement: McpAppPanelRetirement };

export function McpAppPanel(props: McpAppPanelProps) {
  let host!: HTMLElement;
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const [viewId, setViewId] = createSignal("");
  const [busy, setBusy] = createOptimistic(false);
  const [operationReceipt, setOperationReceipt] = createSignal<{
    identity: string;
    result: Promise<null>;
  } | null>(null);
  const [notice, setNotice] = createSignal("");
  const [receipt, setReceipt] = createSignal<{
    identity: string;
    result: Promise<McpAppSettings | null>;
  } | null>(null);
  let generation = 0;
  let mounted = true;
  function recordOutcome(identity: string, pending: Promise<unknown>) {
    const result = pending.then(() => null);
    // A retired panel may never render its outcome; consume late failures too.
    void result.catch(() => {});
    setOperationReceipt({ identity, result });
  }
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
  onSettled(() => () => {
    mounted = false;
    generation++;
  });

  function admit() {
    const launch = props.launch;
    const client = context.gateway.snapshot.client;
    if (
      !launch ||
      !client ||
      client !== launch.owner ||
      context.gateway.snapshot.phase !== "connected"
    ) {
      recordOutcome(openIdentity(), Promise.reject(new UserFacingError(t("mcpApp.disconnected"))));
      return null;
    }
    const currentGeneration = ++generation;
    const identity = launchIdentity();
    const scope = gatewayPresentationScope(context.gateway).key;
    const current = () => {
      return (
        mounted &&
        host.isConnected &&
        generation === currentGeneration &&
        launchIdentity() === identity &&
        props.launch?.owner === client &&
        context.gateway.snapshot.client === client &&
        gatewayPresentationScope(context.gateway).key === scope
      );
    };
    setOperationReceipt(null);
    setNotice("");
    return { client, launch, current, identity: JSON.stringify([identity, scope]) };
  }
  const presentOperation = action(function* (
    current: () => boolean,
    complete: Promise<void>,
    retired: Promise<void>,
  ) {
    if (current()) {
      setBusy(true);
    }
    yield Promise.race([complete, retired]);
  });
  async function operation<T>(
    run: (
      client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>,
      launch: McpAppOpenDetail,
    ) => Promise<T>,
    commit: (result: T, identity: string) => void,
    loadView = false,
  ) {
    const admitted = admit();
    if (!admitted) {
      return;
    }
    const { client, launch } = admitted;
    const retirement = Promise.withResolvers<void>();
    let retired = false;
    const stopRetirement = props.observeRetirement(() => {
      retired = true;
      retirement.resolve();
    });
    const current = () => !retired && admitted.current();
    const complete = (async () => {
      try {
        if (loadView) {
          await McpAppView.preload();
          // Loading presentation yields; recheck the live target before invoking a tool.
          if (!current()) {
            return;
          }
        }
        const result = await run(client, launch);
        if (current()) {
          commit(result, admitted.identity);
        }
      } catch (failure) {
        if (current()) {
          throw failure;
        }
      }
    })();
    recordOutcome(admitted.identity, complete);
    try {
      await Promise.resolve();
      if (!current()) {
        return;
      }
      // The narrow outcome boundary consumes the operation's rejection.
      await presentOperation(current, complete, retirement.promise).catch(() => {});
    } finally {
      stopRetirement();
    }
  }

  const params = (
    launch: McpAppOpenDetail,
    settingsAction: McpAppSettingsParams["action"],
  ): McpAppSettingsParams => ({
    sessionKey: launch.sessionKey,
    agentId: launch.agentId,
    serverName: launch.serverName,
    action: settingsAction,
  });
  function readSettings() {
    const admitted = admit();
    if (!admitted) {
      return;
    }
    const { client, launch, current, identity } = admitted;
    const result = client.request<McpAppSettings>("mcp.app.settings", params(launch, "read")).then(
      (value) => (current() ? value : null),
      (failure: unknown) => {
        if (current()) {
          throw failure;
        }
        return null;
      },
    );
    setReceipt({ identity, result });
  }
  async function open() {
    if (props.launch?.settings) {
      readSettings();
      return;
    }
    await operation(
      (client, launch) =>
        client.request<{ viewId?: string; toolResult?: { isError?: boolean } }>("mcp.app.launch", {
          sessionKey: launch.sessionKey,
          agentId: launch.agentId,
          serverName: launch.serverName,
          toolName: launch.entrypoint.toolName,
          entrypointType: launch.entrypoint.entrypoint.type,
          ...(launch.quickAction ? { quickAction: true } : {}),
          ...(launch.filePath ? { filePath: launch.filePath } : {}),
          ...(launch.deepLink ? { deepLink: launch.deepLink } : {}),
        }),
      (result) => {
        if (result.toolResult?.isError || (!result.viewId && !result.toolResult)) {
          throw new UserFacingError(t("mcpApp.errors.requestFailed"));
        }
        if (result.viewId) {
          setViewId(result.viewId);
        } else {
          setNotice(t("mcpApp.actionComplete"));
        }
      },
      true,
    );
  }
  async function saveSettings(set: McpAppSettings["values"]) {
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
          throw new UserFacingError(t("mcpApp.errors.requestFailed"));
        }
        return client.request<McpAppSettings>("mcp.app.settings", params(launch, "read"));
      },
      (result, identity) => {
        setReceipt({ identity, result: Promise.resolve(result) });
        setNotice(t("mcpApp.settingsSaved"));
      },
    );
  }
  async function runTool(toolName: string) {
    await operation(
      (client, launch) =>
        client.request<{ viewId?: string; toolResult?: { isError?: boolean } }>(
          "mcp.app.settings",
          { ...params(launch, "tool"), toolName },
        ),
      (result) => {
        if (result.toolResult?.isError) {
          throw new UserFacingError(t("mcpApp.errors.requestFailed"));
        }
        if (result.viewId) {
          setReceipt(null);
          setViewId(result.viewId);
        } else {
          setNotice(t("mcpApp.actionComplete"));
        }
      },
      true,
    );
  }
  const openIdentity = createMemo(() => {
    gateway.read();
    return JSON.stringify([launchIdentity(), gatewayPresentationScope(context.gateway).key]);
  });
  const settingsRead = createMemo(() => {
    const identity = openIdentity();
    const admitted = receipt();
    return admitted?.identity === identity ? admitted.result : Promise.resolve(null);
  });
  const currentOperation = () => {
    const admitted = operationReceipt();
    return admitted?.identity === openIdentity() ? admitted : null;
  };
  const SettingsContent = (content: { settings: McpAppSettings | null; pending: boolean }) => (
    <>
      <div class="mcp-app-panel__toolbar">
        <strong>{props.launch?.entrypoint.title}</strong>
        <span class="muted">{props.launch?.serverName}</span>
        <Show when={props.launch?.settings && !content.settings}>
          <button
            class="btn btn--sm"
            disabled={content.pending}
            onClick={() => {
              setViewId("");
              readSettings();
            }}
          >
            {t("mcpApp.settings")}
          </button>
        </Show>
      </div>
      <Show when={content.pending}>
        <p role="status">{t("mcpApp.loading")}</p>
      </Show>
      <Show when={currentOperation()} keyed>
        {(admitted) => {
          const outcome = createMemo(() => admitted.result, { loadingValue: null });
          return (
            <Errored
              fallback={(error) => (
                <>
                  <p role="alert">{formatUiError(error())}</p>
                  <button class="btn" onClick={() => void open()}>
                    {t("mcpApp.retry")}
                  </button>
                </>
              )}
            >
              {outcome()}
            </Errored>
          );
        }}
      </Show>
      <Show when={notice()}>
        <p role="status">{notice()}</p>
      </Show>
      <Show when={content.settings}>
        {(current) => (
          <McpAppSettingsForm
            settings={current()}
            busy={content.pending}
            onSave={(changes) => void saveSettings(changes)}
            onTool={(name) => void runTool(name)}
          />
        )}
      </Show>
    </>
  );
  createEffect(openIdentity, () => {
    // The memo schedules work; each operation samples its live admission target.
    generation++;
    setViewId("");
    setReceipt(null);
    setOperationReceipt(null);
    if (props.launch && props.launch.owner === context.gateway.snapshot.client) {
      void open();
    }
  });
  return (
    <openclaw-mcp-app-panel ref={(element) => (host = element)}>
      <Show when={props.launch}>
        {(launch) => (
          <section class="mcp-app-panel">
            <Errored
              fallback={(failure, reset) => (
                <>
                  <SettingsContent settings={null} pending={false} />
                  <p role="alert">{formatUiError(failure())}</p>
                  <button
                    class="btn"
                    onClick={() => {
                      readSettings();
                      reset();
                    }}
                  >
                    {t("mcpApp.retry")}
                  </button>
                </>
              )}
            >
              <Loading
                on={openIdentity()}
                fallback={<SettingsContent settings={null} pending={true} />}
              >
                <SettingsContent settings={latest(settingsRead)} pending={busy()} />
              </Loading>
            </Errored>
            <McpAppRetirement identity={viewId()} roots={() => [host]}>
              {(id) => {
                // Retiring App content keeps its original target until unmount is acknowledged.
                const initial = untrack(() => ({ launch: launch(), identity: launchIdentity() }));
                const viewLaunch = createMemo<McpAppOpenDetail>((previous) => {
                  const current = launch();
                  return launchIdentity() === initial.identity &&
                    current.owner === initial.launch.owner
                    ? current
                    : (previous ?? initial.launch);
                });
                return id ? (
                  <Loading>
                    <McpAppView
                      sessionKey={viewLaunch().sessionKey}
                      agentId={viewLaunch().agentId ?? ""}
                      viewId={id}
                      title={viewLaunch().entrypoint.title}
                      deepLink={viewLaunch().deepLink}
                      onRelaunch={() => void open()}
                      relaunching={busy()}
                    />
                  </Loading>
                ) : undefined;
              }}
            </McpAppRetirement>
          </section>
        )}
      </Show>
    </openclaw-mcp-app-panel>
  );
}
