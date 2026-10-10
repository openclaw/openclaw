import type { ControlUiFocusTarget } from "@openclaw/session-url-contract";
import { createMemo, createEffect, onCleanup } from "@solidjs/signals";
import { nothing, render, type TemplateResult } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderConnectingSplash } from "../loading-skeleton.ts";
import "./browser-panel.ts";
import { readBrowserTabTarget } from "./browser-target.ts";

export type BrowserDocumentProps = {
  context: ApplicationContext;
  target: Extract<ControlUiFocusTarget, { kind: "browser" }>;
  renderEscape: (label: string) => TemplateResult | typeof nothing;
};

// The app shell still owns these two stateless Lit templates during the cutover.
function ShellTemplate(props: { template: TemplateResult | typeof nothing }) {
  let host!: HTMLSpanElement;
  createEffect(
    () => props.template,
    (template) => {
      render(template, host);
    },
  );
  onCleanup(() => render(nothing, host));
  return (
    <span
      ref={(element) => {
        host = element;
      }}
      style={{ display: "contents" }}
    />
  );
}

export function BrowserDocumentContent(props: { value: BrowserDocumentProps | null }) {
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
          <openclaw-browser-panel
            embedded
            style={available() ? "height: 100dvh;" : "display: none;"}
            prop:client={connected() ? snapshot()!.client : null}
            prop:available={available()}
            prop:remoteAvailable={available()}
            prop:presented={true}
            prop:sessionKey={props.value.target.sessionKey}
            prop:fixedTab={tab() ?? undefined}
            prop:resourceBasePath={props.value.context.resourceBasePath}
            prop:authToken={resolveControlUiAuthToken({
              hello: snapshot()!.hello,
              settings: { token: props.value.context.gateway.connection.token },
              password: props.value.context.gateway.connection.password,
            })}
          />
          {!connected() && snapshot()!.lastError === null ? (
            <ShellTemplate
              template={renderConnectingSplash(
                snapshot()?.phase === "starting" ? t("common.gatewayStarting") : undefined,
              )}
            />
          ) : null}
          {!available() && (connected() || snapshot()!.lastError) ? (
            <main class="connect-splash" role="status">
              <div class="stack">
                <span>{t(tab() ? "browser.unavailable" : "focus.unsupported")}</span>
                <ShellTemplate template={props.value.renderEscape(t("common.back"))} />
              </div>
            </main>
          ) : null}
        </>
      ) : null}
    </>
  );
}
