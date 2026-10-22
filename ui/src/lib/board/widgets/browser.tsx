import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  isPending,
  Loading,
  onSettled,
  Show,
} from "solid-js";
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
import { formatUiError, UserFacingError } from "../../format-error.ts";
import { projectGateway } from "../../reactive/application.ts";
import { useOptionalApplication } from "../../reactive/context.ts";
import { t } from "../../reactive/i18n.ts";
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
  const gateway = context ? projectGateway(context.gateway) : undefined;
  const available = () => Boolean(gateway && isBrowserDashboardAvailable(gateway.read().snapshot));
  const sessionScoped = () => Boolean(gateway && !isBrowserPanelAvailable(gateway.read().snapshot));
  const scope = createMemo(
    () => ({
      client: gateway?.read().snapshot.client,
      key: JSON.stringify([
        props.session,
        props.widget?.instanceId,
        props.widget?.name,
        props.widget?.props,
        gateway?.read().snapshot.hello?.auth,
      ]),
    }),
    { equals: (previous, next) => previous.client === next.client && previous.key === next.key },
  );
  return (
    <Show when={scope()} keyed>
      {(binding) => {
        let dashboard: BrowserDashboard | undefined;
        let error: unknown;
        // Command admission stays synchronous across user and event-driven requests.
        let pending = false;
        let refreshNeeded = false;
        let connected = true;
        type Result = { dashboard: BrowserDashboard | undefined; error: unknown };
        const initial = Promise.withResolvers<Result>();
        const [completion, setCompletion] = createSignal(initial.promise);
        const [working, setWorking] = createOptimistic(false);
        const mutate = action(function* (next: "open" | "resume" | "stop") {
          setWorking(true);
          yield request(next);
        });
        async function request(operation: "open" | "resume" | "stop" | "inspect"): Promise<void> {
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
            void setCompletion(Promise.resolve({ dashboard, error }));
            return;
          }
          if (operation === "inspect") {
            refreshNeeded = false;
          }
          pending = true;
          error = undefined;
          const receipt = Promise.withResolvers<Result>();
          void setCompletion(receipt.promise);
          try {
            const result = await requestBrowserDashboard(
              client,
              {
                ...props.session,
                name: props.widget.name,
                instanceId,
                ...(!isBrowserPanelAvailable(snapshot) ? { sessionScoped: true } : {}),
              },
              operation,
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
              receipt.resolve({ dashboard, error });
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
        onSettled(() => {
          const unsubscribe = context?.gateway.subscribeEvents((event) => {
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
          });
          activate();
          initial.resolve({ dashboard, error });
          return () => {
            connected = false;
            unsubscribe?.();
          };
        });
        const state = createMemo(() => completion());
        const currentError = () =>
          working() || isPending(() => state()) ? undefined : state().error;
        const errorResult = createMemo(() => {
          const current = currentError();
          if (current) {
            throw new UserFacingError(formatUiError(current), { cause: current });
          }
          return null;
        });
        const tab = () => {
          const value = state().dashboard;
          return value?.browserTab && !value.paused ? value : undefined;
        };
        function Footer(footer: { dashboard?: BrowserDashboard; pending: boolean }) {
          return (
            <div class="board-browser__footer">
              <span>
                {t(sessionScoped() ? "browser.dashboardSessionShared" : "browser.dashboardShared")}
              </span>
              <div>
                <button
                  type="button"
                  class="btn btn--small"
                  disabled={footer.pending}
                  onClick={() =>
                    void mutate(
                      footer.dashboard?.stopping
                        ? "stop"
                        : footer.dashboard?.paused
                          ? "resume"
                          : "open",
                    )
                  }
                >
                  {t(
                    footer.dashboard?.stopping
                      ? "browser.dashboardRetryStop"
                      : footer.dashboard?.paused
                        ? "browser.dashboardResume"
                        : "browser.dashboardReconnect",
                  )}
                </button>
                <Show when={footer.dashboard?.browserTab && !footer.dashboard.paused}>
                  <button
                    type="button"
                    class="btn btn--small"
                    disabled={footer.pending}
                    onClick={() => void mutate("stop")}
                  >
                    {t("browser.dashboardStop")}
                  </button>
                </Show>
              </div>
            </div>
          );
        }
        return (
          <>
            <Show when={props.active && available()}>
              {(_active) => {
                onSettled(activate);
                return null;
              }}
            </Show>
            <Loading
              fallback={
                <Show when={props.active}>
                  <Show
                    when={context && available()}
                    fallback={
                      <p class="board-browser__notice">{t("browser.dashboardUnavailable")}</p>
                    }
                  >
                    <div class="board-browser" data-chat-autotype-exempt>
                      <div class="board-browser__content">
                        <p class="board-browser__notice" role="status">
                          {t("browser.loading")}
                        </p>
                      </div>
                      <Footer pending />
                    </div>
                  </Show>
                </Show>
              }
            >
              <Show when={props.active || state().dashboard}>
                <Show
                  when={context && available()}
                  fallback={
                    <p class="board-browser__notice">{t("browser.dashboardUnavailable")}</p>
                  }
                >
                  <div class="board-browser" data-chat-autotype-exempt>
                    <div class="board-browser__content">
                      <Show
                        when={tab()}
                        fallback={
                          <Show
                            when={currentError()}
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
                            <Errored
                              fallback={(caughtError) => (
                                <BoardWidgetError
                                  error={caughtError()}
                                  onRetry={() => void mutate("open")}
                                />
                              )}
                            >
                              {errorResult()}
                            </Errored>
                          </Show>
                        }
                      >
                        {(resolvedDashboard) => (
                          <BrowserPanelHost
                            embedded
                            client={gateway?.read().snapshot.client ?? null}
                            available={available()}
                            remoteAvailable={available()}
                            presented={props.active}
                            sessionKey={resolvedDashboard().sessionKey}
                            fixedTab={resolvedDashboard().browserTab}
                            dashboardTarget={{
                              ...props.session,
                              name: resolvedDashboard().name,
                              instanceId: resolvedDashboard().instanceId,
                              ...(sessionScoped() ? { sessionScoped: true } : {}),
                            }}
                            resourceBasePath={context?.resourceBasePath ?? ""}
                            authToken={resolveControlUiAuthToken({
                              hello: gateway?.read().snapshot.hello ?? null,
                              password: context?.gateway.connection.password ?? "",
                              settings: { token: context?.gateway.connection.token ?? "" },
                            })}
                          />
                        )}
                      </Show>
                    </div>
                    <Footer
                      dashboard={state().dashboard}
                      pending={working() || isPending(() => state())}
                    />
                    <Show when={currentError() && state().dashboard?.browserTab}>
                      <Errored
                        fallback={(caughtError) => (
                          <p role="alert" class="board-browser__error">
                            {formatUiError(caughtError())}
                          </p>
                        )}
                      >
                        {errorResult()}
                      </Errored>
                    </Show>
                  </div>
                </Show>
              </Show>
            </Loading>
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
