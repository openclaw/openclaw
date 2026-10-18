import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import {
  isBrowserDashboardAvailable,
  isBrowserPanelAvailable,
} from "../../../app/panel-availability.ts";
import { BoardWidgetError } from "../../../components/board/board-widget-error.tsx";
import {
  requestBrowserDashboard,
  type BrowserDashboard,
} from "../../../components/browser/browser-client.ts";
import { BrowserPanelHost } from "../../../components/browser/browser-panel.ts";
import { registerBrowserEnglish } from "../../../i18n/locales/en-browser.ts";
import { formatUiError } from "../../format-error.ts";
import { useOptionalApplication } from "../../reactive/context.ts";
import { t } from "../../reactive/i18n.ts";
import { projectSource } from "../../reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../solid-bridge.ts";
import type { BoardWidget } from "../types.ts";
import "./browser.css";

registerBrowserEnglish();
type BrowserWidgetProps = { widget?: BoardWidget; session: BoardGetParams; active: boolean };
function BrowserDashboardWidgetContent(
  props: BrowserWidgetProps,
  host: SolidBridgeElement<BrowserWidgetProps>,
) {
  const context = useOptionalApplication();
  const gateway = projectSource(context?.gateway, {
    read: (owner) => owner?.snapshot,
    subscribe: (owner, notify) => owner?.subscribe(notify) ?? (() => {}),
    equality: "revision",
  });
  const available = () => Boolean(context && isBrowserDashboardAvailable(gateway.read()!));
  const sessionScoped = () => Boolean(context && !isBrowserPanelAvailable(gateway.read()!));
  const scope = createMemo(
    () => ({
      client: gateway.read()?.client,
      key: JSON.stringify([
        props.session,
        props.widget?.instanceId,
        props.widget?.name,
        props.widget?.props,
        gateway.read()?.hello?.auth,
      ]),
    }),
    { equals: (previous, next) => previous.client === next.client && previous.key === next.key },
  );
  return (
    <Show when={scope()} keyed>
      {(binding) => {
        let dashboard: BrowserDashboard | undefined;
        let error: unknown;
        let pending = false;
        let refreshNeeded = false;
        let connected = true;
        const [revision, setRevision] = createSignal(0);
        const publish = () => setRevision((value) => value + 1);
        const state = createMemo(() => {
          revision();
          return { dashboard, error, pending };
        });
        async function request(action: "open" | "resume" | "stop" | "inspect"): Promise<void> {
          const snapshot = context?.gateway.snapshot;
          const instanceId = props.widget?.instanceId;
          if (
            !snapshot ||
            !snapshot.client ||
            snapshot.client !== binding.client ||
            !isBrowserDashboardAvailable(snapshot) ||
            !props.widget ||
            pending
          ) {
            return;
          }
          const client = snapshot.client;
          if (!instanceId) {
            error = new Error(t("browser.dashboardMissingIdentity"));
            publish();
            return;
          }
          if (action === "inspect") {
            refreshNeeded = false;
          }
          pending = true;
          error = undefined;
          publish();
          try {
            const result = await requestBrowserDashboard(
              client,
              {
                ...props.session,
                name: props.widget.name,
                instanceId,
                ...(!isBrowserPanelAvailable(snapshot) ? { sessionScoped: true } : {}),
              },
              action,
            );
            if (connected && host.isConnected && client === context?.gateway.snapshot.client) {
              dashboard = result;
            }
          } catch (failure) {
            if (connected && host.isConnected) {
              error = failure;
            }
          } finally {
            if (connected && host.isConnected) {
              pending = false;
              publish();
              if (refreshNeeded && props.active) {
                void request("inspect");
              } else {
                activate();
              }
            }
          }
        }
        function activate() {
          if (props.active && available() && !pending && !error) {
            if (refreshNeeded) {
              void request("inspect");
            } else if (!dashboard || (!dashboard.paused && !dashboard.browserTab)) {
              void request("open");
            }
          }
        }
        onSettled(() =>
          context?.gateway.subscribeEvents((event) => {
            const payload = asNullableRecord(event.payload);
            if (
              event.event !== "plugin.browser.dashboard_changed" ||
              payload?.instanceId !== props.widget?.instanceId ||
              payload?.name !== props.widget?.name
            ) {
              return;
            }
            refreshNeeded = true;
            if (props.active) {
              void request("inspect");
            }
          }),
        );
        onCleanup(() => {
          connected = false;
        });
        const tab = () => {
          const value = state().dashboard;
          return value?.browserTab && !value.paused ? value : undefined;
        };
        return (
          <>
            <Show when={props.active && available()}>
              {(_active) => {
                onSettled(activate);
                return null;
              }}
            </Show>
            <Show when={props.active || state().dashboard}>
              <Show
                when={context && available()}
                fallback={<p class="board-browser__notice">{t("browser.dashboardUnavailable")}</p>}
              >
                <div class="board-browser" data-chat-autotype-exempt>
                  <div class="board-browser__content">
                    <Show
                      when={tab()}
                      fallback={
                        <Show
                          when={state().error}
                          fallback={
                            <p class="board-browser__notice" role="status">
                              {t(
                                state().dashboard?.stopping
                                  ? "browser.dashboardStopping"
                                  : state().dashboard?.paused
                                    ? "browser.dashboardStopped"
                                    : "browser.loading",
                              )}
                            </p>
                          }
                        >
                          <BoardWidgetError
                            error={state().error}
                            onRetry={() => void request("open")}
                          />
                        </Show>
                      }
                    >
                      <BrowserPanelHost
                        embedded
                        client={gateway.read()?.client ?? null}
                        available={available()}
                        remoteAvailable={available()}
                        presented={props.active}
                        sessionKey={tab()!.sessionKey}
                        fixedTab={tab()!.browserTab}
                        dashboardTarget={{
                          ...props.session,
                          name: tab()!.name,
                          instanceId: tab()!.instanceId,
                          ...(sessionScoped() ? { sessionScoped: true } : {}),
                        }}
                        resourceBasePath={context?.resourceBasePath ?? ""}
                        authToken={resolveControlUiAuthToken({
                          hello: gateway.read()?.hello ?? null,
                          password: context?.gateway.connection.password ?? "",
                          settings: { token: context?.gateway.connection.token ?? "" },
                        })}
                      />
                    </Show>
                  </div>
                  <div class="board-browser__footer">
                    <span>
                      {t(
                        sessionScoped()
                          ? "browser.dashboardSessionShared"
                          : "browser.dashboardShared",
                      )}
                    </span>
                    <div>
                      <button
                        type="button"
                        class="btn btn--small"
                        disabled={state().pending}
                        onClick={() =>
                          void request(
                            state().dashboard?.stopping
                              ? "stop"
                              : state().dashboard?.paused
                                ? "resume"
                                : "open",
                          )
                        }
                      >
                        {t(
                          state().dashboard?.stopping
                            ? "browser.dashboardRetryStop"
                            : state().dashboard?.paused
                              ? "browser.dashboardResume"
                              : "browser.dashboardReconnect",
                        )}
                      </button>
                      <Show when={tab()}>
                        <button
                          type="button"
                          class="btn btn--small"
                          disabled={state().pending}
                          onClick={() => void request("stop")}
                        >
                          {t("browser.dashboardStop")}
                        </button>
                      </Show>
                    </div>
                  </div>
                  <Show when={state().error && state().dashboard?.browserTab}>
                    <p role="alert" class="board-browser__error">
                      {formatUiError(state().error)}
                    </p>
                  </Show>
                </div>
              </Show>
            </Show>
          </>
        );
      }}
    </Show>
  );
}
export const BrowserDashboardWidget = defineSolidBridge<BrowserWidgetProps>(
  "openclaw-browser-dashboard-widget",
  BrowserDashboardWidgetContent,
  {
    properties: {
      widget: { default: undefined, attribute: false },
      session: { default: { sessionKey: "" }, attribute: false },
      active: { default: true, type: Boolean },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-dashboard-widget": SolidBridgeElement<BrowserWidgetProps>;
  }
}
