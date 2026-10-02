import { html, nothing } from "lit";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { withPromiseModalHost } from "../components/promise-modal-host.ts";
import { t } from "../i18n/index.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { notifyBrowserAuthRestored, subscribeBrowserHttpFailures } from "./browser-http.ts";
import {
  fetchWithControlUiAuth,
  resolveControlUiAuthCandidates,
  type ControlUiAuthSource,
} from "./control-ui-auth.ts";
import { webKitHostWindow } from "./native-webkit-bridge.ts";

function renewBrowserSession(url: URL, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    // Navigation follows cookie-based SSO redirects without CORS/connect-src
    // exceptions or Gateway credentials. The frame cannot run scripts or leave itself.
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.referrerPolicy = "no-referrer";
    frame.src = url.href;
    const finish = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      frame.remove();
      resolve();
    };
    const timeout = window.setTimeout(finish, 10_000);
    frame.addEventListener("load", finish, { once: true });
    frame.addEventListener("error", finish, { once: true });
    signal.addEventListener("abort", finish, { once: true });
    document.body.append(frame);
  });
}

/** The document owns proxy sign-in; a healthy WebSocket does not establish HTTP access. */
export function startBrowserAuthRecovery(
  resourceBasePath: string,
  getAuth: () => ControlUiAuthSource = () => ({}),
): () => void {
  const root = new URL(`${normalizeBasePath(resourceBasePath)}/`, window.location.origin);
  const probeUrl = new URL(CONTROL_UI_BOOTSTRAP_CONFIG_PATH.slice(1), root);
  const lifetime = new AbortController();
  let pending: Promise<void> | undefined;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let signInRequired = false;
  let dismissed = false;
  let openedSignIn = false;
  let dialog: { close: () => void; update: () => void } | undefined;
  let probeResult: "unavailable" | "sign-in" | undefined;

  const showDialog = () => {
    if (dialog || dismissed || lifetime.signal.aborted) {
      return;
    }
    void withPromiseModalHost({ signal: lifetime.signal, value: undefined }, (modal) => {
      const dismiss = () => {
        dismissed = true;
        modal.finish(undefined);
      };
      const content = () => html`
        <openclaw-modal-dialog
          label=${t("connection.browserSignIn.title")}
          description=${t("connection.browserSignIn.description")}
          @modal-cancel=${dismiss}
        >
          <div class="exec-approval-card">
            <div class="exec-approval-header">
              <div style="min-width: 0">
                <div class="exec-approval-title">${t("connection.browserSignIn.title")}</div>
                <div class="exec-approval-sub" style="white-space: normal">
                  ${t("connection.browserSignIn.description")}
                </div>
              </div>
            </div>
            ${openedSignIn ? html`<p>${t("connection.browserSignIn.returnHint")}</p>` : nothing}
            <p role="status" aria-live="polite">
              ${
                pending
                  ? t("connection.browserSignIn.checking")
                  : probeResult === "unavailable"
                    ? t("connection.browserSignIn.unavailable")
                    : probeResult === "sign-in"
                      ? t("connection.browserSignIn.stillRequired")
                      : nothing
              }
            </p>
            <div class="exec-approval-actions">
              <button
                class="btn primary"
                @click=${async () => {
                  if (webKitHostWindow()?.webkit?.messageHandlers?.openclawGateways) {
                    const { nativeGatewaysCapability } =
                      await import("./native-gateways.runtime.ts");
                    if (lifetime.signal.aborted || dismissed) {
                      return;
                    }
                    const native = nativeGatewaysCapability();
                    const currentId = native?.snapshot?.currentId;
                    if (native && currentId) {
                      // The app owns a separate cookie store; a normal browser tab cannot renew it.
                      native.reconnect(currentId);
                      return;
                    }
                  }
                  openedSignIn = true;
                  probeResult = undefined;
                  openExternalUrlSafe(root.href);
                  modal.render(content);
                }}
              >
                ${t("connection.browserSignIn.action")}
              </button>
              ${openedSignIn ? html`<button class="btn" ?disabled=${Boolean(pending)} @click=${() => void check(true)}>${t("connection.browserSignIn.checkAgain")}</button>` : nothing}
              <button class="btn" @click=${dismiss}>
                ${t("connection.browserSignIn.dismiss")}
              </button>
            </div>
          </div>
        </openclaw-modal-dialog>
      `;
      dialog = { close: () => modal.finish(undefined), update: () => modal.render(content) };
      modal.render(content);
    }).finally(() => {
      dialog = undefined;
    });
  };

  function check(explicit = false): Promise<void> | undefined {
    if (lifetime.signal.aborted || pending || (!explicit && Date.now() - lastProbeAt < 30_000)) {
      return pending;
    }
    lastProbeAt = Date.now();
    const authCandidates = resolveControlUiAuthCandidates(getAuth());
    const isCurrent = () => {
      const current = resolveControlUiAuthCandidates(getAuth());
      return (
        !lifetime.signal.aborted &&
        current.length === authCandidates.length &&
        current.every((candidate, index) => candidate === authCandidates[index])
      );
    };
    pending = (async () => {
      try {
        // This canonical endpoint never redirects. Manual mode exposes an edge
        // redirect without following it or forwarding Gateway credentials to it.
        const probe = () =>
          fetchWithControlUiAuth(
            probeUrl.href,
            {
              method: "HEAD",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "manual",
              signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]),
            },
            authCandidates,
            isCurrent,
          );
        let response = await probe();
        if (!isCurrent()) {
          return;
        }
        if (response.type === "opaqueredirect" && !signInRequired) {
          signInRequired = true;
          await renewBrowserSession(probeUrl, lifetime.signal);
          if (!isCurrent()) {
            return;
          }
          // Login/error pages can also finish loading (or refuse framing).
          // Only a fresh authenticated probe establishes renewed HTTP access.
          response = await probe();
        }
        if (!isCurrent()) {
          return;
        }
        if (response.type === "opaqueredirect") {
          signInRequired = true;
          probeResult = openedSignIn ? "sign-in" : undefined;
          showDialog();
        } else if (
          response.ok &&
          response.headers.get("content-type")?.split(";")[0]?.trim() === "application/json"
        ) {
          const recovered = signInRequired;
          signInRequired = false;
          dismissed = false;
          openedSignIn = false;
          dialog?.close();
          if (recovered) {
            notifyBrowserAuthRestored();
          }
        } else {
          probeResult = "unavailable";
        }
      } catch {
        if (isCurrent()) {
          probeResult = "unavailable";
        }
      }
    })().finally(() => {
      pending = undefined;
      dialog?.update();
    });
    dialog?.update();
    return pending;
  }

  const stopFailures = subscribeBrowserHttpFailures((url) => {
    let request: URL;
    try {
      request = new URL(url, window.location.href);
    } catch {
      return;
    }
    if (request.origin === root.origin && request.pathname.startsWith(root.pathname)) {
      void check();
    }
  });
  const serviceWorker = navigator.serviceWorker;
  const onWorkerMessage = (event: MessageEvent) => {
    if (
      serviceWorker?.controller &&
      event.source === serviceWorker.controller &&
      event.data?.type === "openclaw-http-request-failed"
    ) {
      void check();
    }
  };
  const onFocus = () => {
    if (signInRequired) {
      void check(true);
    }
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      onFocus();
    }
  };
  serviceWorker?.addEventListener("message", onWorkerMessage, { signal: lifetime.signal });
  window.addEventListener("focus", onFocus, { signal: lifetime.signal });
  document.addEventListener("visibilitychange", onVisibilityChange, { signal: lifetime.signal });
  return () => {
    lifetime.abort();
    stopFailures();
  };
}
