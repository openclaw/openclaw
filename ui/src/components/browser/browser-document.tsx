import type { ControlUiFocusTarget } from "@openclaw/session-url-contract";
import { createMemo, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lib/solid-bridge.ts";
import { ConnectingSplash } from "../solid/loading-skeleton.tsx";
import { BrowserPanelHost } from "./browser-panel.ts";
import { readBrowserTabTarget } from "./browser-target.ts";

registerEnglishCatalog(registerBrowserEnglish);

export type BrowserDocumentViewProps = {
  context: ApplicationContext;
  target: Extract<ControlUiFocusTarget, { kind: "browser" }>;
  renderEscape: (label: string) => HTMLElement | null;
};

export type BrowserDocumentProps = BrowserDocumentViewProps;

export function BrowserDocumentContent(props: { value: BrowserDocumentViewProps | null }) {
  return (
    <Show when={props.value} keyed>
      {(value) => {
        const gateway = projectGateway(value.context.gateway);
        const snapshot = () => gateway.read().snapshot;
        const connected = () => snapshot().phase === "connected";
        const tab = createMemo(() => readBrowserTabTarget(value.target.tab));
        const available = () => Boolean(tab() && isBrowserPanelAvailable(snapshot()));
        return (
          <>
            <BrowserPanelHost
              embedded
              style={available() ? "height: 100dvh;" : "display: none;"}
              client={connected() ? snapshot().client : null}
              available={available()}
              remoteAvailable={available()}
              presented={true}
              sessionKey={value.target.sessionKey}
              fixedTab={tab() ?? undefined}
              resourceBasePath={value.context.resourceBasePath}
              authToken={resolveControlUiAuthToken({
                hello: snapshot().hello,
                settings: { token: gateway.read().connection.token },
                password: gateway.read().connection.password,
              })}
            />
            {!connected() && snapshot().lastError === null ? (
              <ConnectingSplash
                status={snapshot().phase === "starting" ? t("common.gatewayStarting") : undefined}
              />
            ) : null}
            {!available() && (connected() || snapshot().lastError) ? (
              <main class="connect-splash" role="status">
                <div class="stack">
                  <span>{t(tab() ? "browser.unavailable" : "focus.unsupported")}</span>
                  {value.renderEscape(t("common.back"))}
                </div>
              </main>
            ) : null}
          </>
        );
      }}
    </Show>
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-document": HTMLElement & {
      props: BrowserDocumentProps | null;
    };
  }
}

export const BrowserDocument = defineSolidBridge<{ props: BrowserDocumentProps | null }>(
  "openclaw-browser-document",
  (props, host) => {
    host.style.display = "contents";
    return <BrowserDocumentContent value={props.props} />;
  },
  { properties: { props: { default: null, attribute: false } } },
);
