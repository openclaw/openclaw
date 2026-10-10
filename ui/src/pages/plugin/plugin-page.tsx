import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { registerShellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { isStaleChunkImportError } from "../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { registerLoginEnglish } from "../../i18n/locales/en-login.ts";
import { resolveEmbedSandbox } from "../../lib/chat/tool-display.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { CustomPluginUiDisabled } from "../../plugins/control-ui-disabled.solid.tsx";
import { PluginContribution } from "../../plugins/control-ui-view.solid.tsx";
import {
  BUNDLED_TAB_VIEWS,
  PluginPageLifecycle,
  type PluginPageProps,
} from "./plugin-page-lifecycle.ts";
export type { PluginPageProps } from "./plugin-page-lifecycle.ts";

registerLoginEnglish();

function PluginPageContent(props: PluginPageProps, host: HTMLElement) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const lifecycle = new PluginPageLifecycle(props, context, () =>
    setRevision((value) => value + 1),
  );
  lifecycle.host = host;
  host.style.display = "contents";
  const gateway = projectGateway(context.gateway);
  const plugins = projectSource(context.plugins, {
    read: (source) => source,
    subscribe: (source, notify) => source?.subscribe(notify) ?? (() => {}),
    equality: "revision",
  });
  const update = () => {
    lifecycle.update();
    setRevision((value) => value + 1);
  };
  const unsubscribeGateway = gateway.subscribe(update);
  const unsubscribePlugins = plugins.subscribe(update);
  createEffect(() => [props.pluginId, props.tabId], update);
  lifecycle.connect();
  update();
  onCleanup(() => {
    unsubscribeGateway();
    unsubscribePlugins();
    lifecycle.dispose();
  });
  const info = () => {
    revision();
    return lifecycle.tabInfo();
  };
  const viewState = () => {
    revision();
    return lifecycle.bundledViewState;
  };
  const key = () => {
    revision();
    return lifecycle.tabKey();
  };
  const contribution = () => {
    revision();
    return context.plugins?.registrations("pages").some((entry) => entry.key === key());
  };
  const bundled = () => Boolean(info() && key() in BUNDLED_TAB_VIEWS && !contribution());
  const external = () => !contribution() && !bundled() && info()?.path;
  const authKey = () => lifecycle.externalTabAuthKey(info(), false);
  const insecure = () =>
    external() && info()?.requiresGatewayAuth === true && !window.isSecureContext;
  const unavailable = () => {
    revision();
    return (
      external() &&
      info()?.requiresGatewayAuth === true &&
      lifecycle.externalAuthUnavailableKey === authKey()
    );
  };
  const showFrame = () => {
    revision();
    return (
      external() &&
      !insecure() &&
      !unavailable() &&
      (info()?.requiresGatewayAuth !== true || lifecycle.externalAuthReadyKey === authKey())
    );
  };
  createEffect(showFrame, (visible) =>
    visible ? registerShellLayoutTraits(host, { pluginEmbed: true }) : undefined,
  );
  const generation = () => {
    revision();
    return lifecycle.pluginFrameGeneration;
  };
  const readyView = () => {
    revision();
    return lifecycle.readyBundledView();
  };
  const disabled = () => {
    revision();
    return context.plugins?.errors.some(
      (entry) => entry.pluginId === props.pluginId && entry.code === "custom-plugin-ui-disabled",
    );
  };
  const loading = () => {
    revision();
    return (
      context.gateway.snapshot.phase !== "connected" ||
      context.plugins?.isLoading(props.pluginId ?? "")
    );
  };
  const unavailableMessage = () => {
    revision();
    return (
      context.plugins?.errors.find((entry) => entry.pluginId === props.pluginId)?.message ??
      t("pluginTabs.unavailableSubtitle")
    );
  };
  return (
    <>
      <Show when={contribution()}>
        <PluginContribution kind="pages" contributionKey={key()} props={props.params ?? {}} />
      </Show>
      <Show when={bundled()}>
        <Show when={viewState().status === "loading"}>
          <LoadingState />
        </Show>
        <Show when={viewState().status === "error"}>
          {(_visible) => {
            const error = () => {
              const current = viewState();
              return current.status === "error" ? current.error : undefined;
            };
            return (
              <LazyViewError
                error={error()}
                onRetry={lifecycle.retryBundledView}
                stale={isStaleChunkImportError(error())}
              />
            );
          }}
        </Show>
        <Show when={readyView()} keyed>
          {(view) =>
            view.render({
              get host() {
                revision();
                return lifecycle.bundledViewHost;
              },
              get client() {
                gateway.revision();
                return context.gateway.snapshot.client;
              },
              get connected() {
                gateway.revision();
                return context.gateway.snapshot.phase === "connected";
              },
            })
          }
        </Show>
      </Show>
      <Show when={insecure()}>
        <section class="card lazy-view-state" role="status">
          <div class="card-title">{t("login.failure.insecure.title")}</div>
          <div class="card-sub">{t("login.failure.insecure.stepHttps")}</div>
        </section>
      </Show>
      <Show when={unavailable()}>
        <section class="card lazy-view-state" role="status">
          <div class="card-title">{t("pluginTabs.unavailableTitle")}</div>
          <div class="card-sub">{t("pluginTabs.unavailableSubtitle")}</div>
        </section>
      </Show>
      <Show when={showFrame()}>
        <section class="plugin-tab-embed">
          <Show when={generation()} keyed>
            {(_generation) => {
              onCleanup(() => lifecycle.syncPluginThemeFrame(null));
              return (
                <iframe
                  class="plugin-tab-embed__frame"
                  src={info()?.path}
                  title={info()?.label}
                  sandbox={resolveEmbedSandbox(context.config.current.embedSandboxMode)}
                  ref={(frame) => lifecycle.syncPluginThemeFrame(frame)}
                  onLoad={lifecycle.handlePluginThemeLoad}
                />
              );
            }}
          </Show>
        </section>
      </Show>
      <Show when={!contribution() && !bundled() && !external()}>
        <Show
          when={loading()}
          fallback={
            <section class="card lazy-view-state" role="status">
              <Show
                when={disabled()}
                fallback={
                  <>
                    <div class="card-title">{t("pluginTabs.unavailableTitle")}</div>
                    <div class="card-sub">{unavailableMessage()}</div>
                  </>
                }
              >
                <CustomPluginUiDisabled context={context} pluginId={props.pluginId ?? ""} />
              </Show>
            </section>
          }
        >
          <LoadingState />
        </Show>
      </Show>
    </>
  );
}

export const PluginPage = defineSolidBridge<PluginPageProps>(
  "openclaw-plugin-page",
  PluginPageContent,
  {
    properties: {
      pluginId: { default: "", attribute: false },
      tabId: { default: "", attribute: false },
      params: { default: {}, attribute: false },
    },
  },
);

export type PluginPageElement = SolidBridgeElement<PluginPageProps>;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-page": PluginPageElement;
  }
}
