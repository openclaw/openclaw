import { createEffect, createMemo, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { isStaleChunkImportError } from "../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { registerLoginEnglish } from "../../i18n/locales/en-login.ts";
import { resolveEmbedSandbox } from "../../lib/chat/tool-display.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { CustomPluginUiDisabled } from "../../plugins/control-ui-disabled.solid.tsx";
import { PluginContribution } from "../../plugins/control-ui-view.solid.tsx";
import {
  BUNDLED_TAB_VIEWS,
  PluginPageOwner,
  type PluginPageProps,
} from "./plugin-page-lifecycle.ts";
export type { PluginPageProps } from "./plugin-page-lifecycle.ts";

registerLoginEnglish();

function PluginPageContent(props: PluginPageProps, host: HTMLElement) {
  const context = useApplication();
  const lifecycle = new PluginPageOwner(props, context, host);
  const projection = projectOwner(lifecycle, (source) => source);
  host.style.display = "contents";
  // Owner callbacks snapshot route props at admission; frame auth and lazy views retire stale results.
  const update = () => untrack(lifecycle.update);
  const unsubscribeGateway = context.gateway.subscribe(update);
  const unsubscribePlugins = context.plugins?.subscribe(update);
  createEffect(() => [props.pluginId, props.tabId], update);
  update();
  onCleanup(() => {
    unsubscribeGateway();
    unsubscribePlugins?.();
    lifecycle.dispose();
  });
  const view = createMemo(() => {
    projection.read();
    const info = lifecycle.tabInfo();
    const key = lifecycle.tabKey();
    const contribution = context.plugins?.registrations("pages").some((entry) => entry.key === key);
    const authKey = lifecycle.externalTabAuthKey(info, false);
    let mode = "unavailable";
    if (contribution) {
      mode = "native";
    } else if (info && key in BUNDLED_TAB_VIEWS) {
      mode = "bundled";
    } else if (info?.path) {
      mode = "frame";
      if (info.requiresGatewayAuth === true) {
        if (!window.isSecureContext) {
          mode = "insecure";
        } else if (lifecycle.externalAuthUnavailableKey === authKey) {
          mode = "unavailable";
        } else if (lifecycle.externalAuthReadyKey !== authKey) {
          mode = "pending";
        }
      }
    } else if (
      context.gateway.snapshot.phase !== "connected" ||
      context.plugins?.isLoading(props.pluginId ?? "")
    ) {
      mode = "loading";
    }
    return {
      info,
      key,
      mode,
      state: lifecycle.bundledViewState,
      generation: lifecycle.pluginFrameGeneration,
      bundledHost: lifecycle.bundledViewHost,
    };
  });
  const readyView = () => {
    const state = view().state;
    return state.status === "ready" ? state.view : undefined;
  };
  const error = () => {
    const state = view().state;
    return state.status === "error" ? state.error : undefined;
  };
  const disabled = () =>
    !view().info?.path &&
    context.plugins?.errors.some(
      (entry) => entry.pluginId === props.pluginId && entry.code === "custom-plugin-ui-disabled",
    );
  const unavailableMessage = () =>
    view().info?.path
      ? t("pluginTabs.unavailableSubtitle")
      : (context.plugins?.errors.find((entry) => entry.pluginId === props.pluginId)?.message ??
        t("pluginTabs.unavailableSubtitle"));
  return (
    <Switch>
      <Match when={view().mode === "native"}>
        <PluginContribution kind="pages" contributionKey={view().key} props={props.params ?? {}} />
      </Match>
      <Match when={view().mode === "bundled"}>
        <Show when={view().state.status === "loading"}>
          <LoadingState />
        </Show>
        <Show when={view().state.status === "error"}>
          <LazyViewError
            error={error()}
            onRetry={lifecycle.retryBundledView}
            stale={isStaleChunkImportError(error())}
          />
        </Show>
        <Show when={readyView()} keyed>
          {(loaded) => (
            <Show when={view().bundledHost} keyed>
              {(_epoch) =>
                loaded.render({
                  get client() {
                    return projection.read().context.gateway.snapshot.client;
                  },
                  get connected() {
                    return projection.read().context.gateway.snapshot.phase === "connected";
                  },
                })
              }
            </Show>
          )}
        </Show>
      </Match>
      <Match when={view().mode === "insecure"}>
        <section class="card lazy-view-state" role="status">
          <div class="card-title">{t("login.failure.insecure.title")}</div>
          <div class="card-sub">{t("login.failure.insecure.stepHttps")}</div>
        </section>
      </Match>
      <Match when={view().mode === "frame"}>
        <ShellLayoutBoundary traits={{ pluginEmbed: true }}>
          <section class="plugin-tab-embed">
            <Show when={view().generation} keyed>
              {(_generation) => {
                onCleanup(() => lifecycle.syncPluginThemeFrame(null));
                return (
                  <iframe
                    class="plugin-tab-embed__frame"
                    src={view().info?.path}
                    title={view().info?.label}
                    sandbox={resolveEmbedSandbox(context.config.current.embedSandboxMode)}
                    ref={(frame) => lifecycle.syncPluginThemeFrame(frame)}
                    onLoad={lifecycle.handlePluginThemeLoad}
                  />
                );
              }}
            </Show>
          </section>
        </ShellLayoutBoundary>
      </Match>
      <Match when={view().mode === "loading"}>
        <LoadingState />
      </Match>
      <Match when={view().mode === "unavailable"}>
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
      </Match>
    </Switch>
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
