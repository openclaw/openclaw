import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, Errored, Loading, onSettled, Show } from "solid-js";
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
import { projectMutableSource } from "../../reactive/projection.ts";
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
        // A failed activation waits for explicit retry or a dashboard event.
        let failed = false;
        // Command admission stays synchronous across user and event-driven requests.
        let pending = false;
        let refreshNeeded = false;
        let connected = true;
        const isCurrent = () => connected && host.isConnected && scope() === binding;
        const state = projectMutableSource(null, () => ({ dashboard, pending }));
        const [completion, setCompletion] = createSignal<Promise<void>>();
        async function request(operation: "open" | "resume" | "stop" | "inspect"): Promise<void> {
          const snapshot = context?.gateway.snapshot;
          const widget = props.widget;
          const instanceId = widget?.instanceId;
          if (
            !snapshot ||
            !snapshot.client ||
            !isCurrent() ||
            snapshot.client !== binding.client ||
            !isBrowserDashboardAvailable(snapshot) ||
            !widget ||
            pending
          ) {
            return;
          }
          const client = snapshot.client;
          if (operation === "inspect") {
            refreshNeeded = false;
          }
          pending = true;
          failed = false;
          const task = (async () => {
            try {
              if (!instanceId) {
                throw new Error(t("browser.dashboardMissingIdentity"));
              }
              const result = await requestBrowserDashboard(
                client,
                {
                  ...props.session,
                  name: widget.name,
                  instanceId,
                  ...(!isBrowserPanelAvailable(snapshot) ? { sessionScoped: true } : {}),
                },
                operation,
              );
              if (isCurrent() && client === context?.gateway.snapshot.client) {
                dashboard = result;
              }
            } catch (failure) {
              if (isCurrent()) {
                failed = true;
                throw new UserFacingError(formatUiError(failure), { cause: failure });
              }
            } finally {
              if (isCurrent()) {
                pending = false;
                state.publish();
                if (refreshNeeded && props.active) {
                  void request("inspect");
                } else {
                  activate();
                }
              }
            }
          })();
          void setCompletion(task);
          state.publish();
          // Consume the task even if its error slot has been disposed.
          await task.catch(() => undefined);
        }
        function activate() {
          if (props.active && available() && !pending && !failed) {
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
          return () => {
            connected = false;
            unsubscribe?.();
          };
        });
        const ready = createMemo(() => completion()?.then(() => null) ?? null);
        const tab = () => {
          const value = state.read().dashboard;
          return value?.browserTab && !value.paused ? value : undefined;
        };
        const Status = () => (
          <p class="board-browser__notice" role="status">
            {t(
              state.read().dashboard?.stopping
                ? "browser.dashboardStopping"
                : state.read().dashboard?.paused
                  ? "browser.dashboardStopped"
                  : "browser.loading",
            )}
          </p>
        );
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
                    void request(
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
                    onClick={() => void request("stop")}
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
            <Show when={props.active || state.read().dashboard}>
              <Show
                when={context && available()}
                fallback={<p class="board-browser__notice">{t("browser.dashboardUnavailable")}</p>}
              >
                <div class="board-browser" data-chat-autotype-exempt>
                  <div class="board-browser__content">
                    <Show
                      when={tab()}
                      fallback={
                        <Loading on={completion()} fallback={<Status />}>
                          <Errored
                            fallback={(caughtError) => (
                              <BoardWidgetError
                                error={caughtError()}
                                onRetry={() => void request("open")}
                              />
                            )}
                          >
                            {ready()}
                            <Status />
                          </Errored>
                        </Loading>
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
                  <Footer dashboard={state.read().dashboard} pending={state.read().pending} />
                  <Show when={tab()}>
                    <Loading on={completion()}>
                      <Errored
                        fallback={(caughtError) => (
                          <p role="alert" class="board-browser__error">
                            {formatUiError(caughtError())}
                          </p>
                        )}
                      >
                        {ready()}
                      </Errored>
                    </Loading>
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
