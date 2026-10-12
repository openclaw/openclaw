import type { ControlUiFocusTarget } from "@openclaw/session-url-contract";
import { createMemo } from "@solidjs/signals";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { BrowserPanelHost } from "./browser-panel.ts";
import { readBrowserTabTarget } from "./browser-target.ts";

export type BrowserDocumentViewProps = {
  context: ApplicationContext;
  target: Extract<ControlUiFocusTarget, { kind: "browser" }>;
  renderEscape: (label: string) => unknown;
};

export function BrowserDocumentContent(props: {
  value: BrowserDocumentViewProps | null;
  renderTemplate: (read: () => unknown) => HTMLElement;
  renderConnecting: (status?: string) => unknown;
}) {
  const snapshot = createMemo(() => props.value?.context.gateway.snapshot);
  const connected = createMemo(() => snapshot()?.phase === "connected");
  const tab = createMemo(() => props.value && readBrowserTabTarget(props.value.target.tab));
  const available = createMemo(() =>
    Boolean(tab() && snapshot() && isBrowserPanelAvailable(snapshot()!)),
  );
  return (
    <>
      {props.value ? (
        <>
          <BrowserPanelHost
            embedded
            style={available() ? "height: 100dvh;" : "display: none;"}
            client={connected() ? snapshot()!.client : null}
            available={available()}
            remoteAvailable={available()}
            presented={true}
            sessionKey={props.value.target.sessionKey}
            fixedTab={tab() ?? undefined}
            resourceBasePath={props.value.context.resourceBasePath}
            authToken={resolveControlUiAuthToken({
              hello: snapshot()!.hello,
              settings: { token: props.value.context.gateway.connection.token },
              password: props.value.context.gateway.connection.password,
            })}
          />
          {!connected() && snapshot()!.lastError === null
            ? props.renderTemplate(() =>
                props.renderConnecting(
                  snapshot()?.phase === "starting" ? t("common.gatewayStarting") : undefined,
                ),
              )
            : null}
          {!available() && (connected() || snapshot()!.lastError) ? (
            <main class="connect-splash" role="status">
              <div class="stack">
                <span>{t(tab() ? "browser.unavailable" : "focus.unsupported")}</span>
                {props.renderTemplate(() => props.value!.renderEscape(t("common.back")))}
              </div>
            </main>
          ) : null}
        </>
      ) : null}
    </>
  );
}
