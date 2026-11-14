import {
  createEffect,
  createMemo,
  Errored,
  lazy,
  Loading,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { registerLoginEnglish } from "../../i18n/locales/en-login.ts";
import { resolveEmbedSandbox } from "../../lib/chat/canvas-embed-policy.ts";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { CustomPluginUiDisabled } from "../../plugins/control-ui-disabled.solid.tsx";
import { PluginContribution } from "../../plugins/control-ui-view.solid.tsx";
import { PluginPageOwner, type PluginPageProps } from "./plugin-page-lifecycle.ts";
export type { PluginPageProps } from "./plugin-page-lifecycle.ts";

registerLoginEnglish();

function PluginPageContent(props: PluginPageProps, host: HTMLElement) {
  const context = useApplication();
  const { owner: lifecycle, view: projection } = projectCallbackOwner(
    (notify) => new PluginPageOwner(props, context, host, notify),
    (source) => source,
  );
  const plugins = context.plugins && projectOwner(context.plugins, (source) => source).read;
  host.style.display = "contents";
  // Gateway receipts retire bundled views and frame-auth work before a replacement connection uses them.
  const unsubscribeGateway = context.gateway.subscribe(lifecycle.update);
  createEffect(() => [props.pluginId, props.tabId], lifecycle.update);
  onCleanup(() => {
    unsubscribeGateway();
    lifecycle.dispose();
  });
  const view = createMemo(() => {
    projection.read();
    const info = lifecycle.tabInfo();
    const key = lifecycle.tabKey();
    const contribution = plugins?.()
      .registrations("pages")
      .some((entry) => entry.key === key);
    const authKey = lifecycle.externalTabAuthKey(info, false);
    let mode = "unavailable";
    if (contribution) {
      mode = "native";
    } else if (lifecycle.hasBundledView(info)) {
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
      plugins?.().isLoading(props.pluginId ?? "")
    ) {
      mode = "loading";
    }
    return {
      info,
      key,
      mode,
      generation: lifecycle.pluginFrameGeneration,
      bundledHost: lifecycle.bundledViewHost,
    };
  });
  const disabled = () =>
    !view().info?.path &&
    plugins?.().errors.some(
      (entry) => entry.pluginId === props.pluginId && entry.code === "custom-plugin-ui-disabled",
    );
  const unavailableMessage = () =>
    view().info?.path
      ? t("pluginTabs.unavailableSubtitle")
      : (plugins?.().errors.find((entry) => entry.pluginId === props.pluginId)?.message ??
        t("pluginTabs.unavailableSubtitle"));

  function BundledView() {
    // Retire the import with its descriptor; Gateway epochs only remount the loaded view.
    const Logbook = lazy(() => import("./logbook-view.tsx"), { export: "Logbook" });
    return (
      <Errored
        fallback={(error, reset) => {
          const staleError = () => {
            const failure = error();
            return isStaleChunkImportError(failure) ? failure : undefined;
          };
          return (
            <>
              <Show when={staleError()} keyed>
                {(_failure) => {
                  let current = true;
                  onSettled(() => {
                    void scheduleStaleChunkReload({
                      canReload: () => current && lifecycle.hasBundledView(),
                    });
                    return () => {
                      current = false;
                    };
                  });
                  return null;
                }}
              </Show>
              <LazyViewError
                error={error()}
                stale={Boolean(staleError())}
                onRetry={() => {
                  if (!lifecycle.hasBundledView()) {
                    return;
                  }
                  if (staleError()) {
                    void retryStaleChunkReloadWhenReachable({
                      canReload: () => lifecycle.hasBundledView(),
                    });
                  } else {
                    reset();
                  }
                }}
              />
            </>
          );
        }}
      >
        <Loading fallback={<LoadingState />}>
          <Show when={view().bundledHost} keyed>
            {(_epoch) => {
              const initialClient =
                context.gateway.snapshot.phase === "connected"
                  ? context.gateway.snapshot.client
                  : null;
              return (
                <Logbook initialClient={initialClient} getRetired={() => lifecycle.actionRetired} />
              );
            }}
          </Show>
        </Loading>
      </Errored>
    );
  }

  return (
    <Switch>
      <Match when={view().mode === "native"}>
        <PluginContribution kind="pages" contributionKey={view().key} props={props.params ?? {}} />
      </Match>
      <Match when={view().mode === "bundled"}>
        <BundledView />
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
                let frame!: HTMLIFrameElement;
                onSettled(() => {
                  lifecycle.syncPluginThemeFrame(frame);
                  return () => lifecycle.syncPluginThemeFrame(null);
                });
                return (
                  <iframe
                    class="plugin-tab-embed__frame"
                    src={view().info?.path}
                    title={view().info?.label}
                    sandbox={resolveEmbedSandbox(context.config.current.embedSandboxMode)}
                    ref={(element) => (frame = element)}
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
