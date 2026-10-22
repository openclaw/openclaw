import { createStore, Errored, lazy, Loading } from "solid-js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { withPromiseModalHost } from "../components/promise-modal-host.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { notifyBrowserAuthRestored, bindBrowserHttpFailures } from "./browser-http.ts";
import {
  fetchWithControlUiAuth,
  resolveControlUiAuthCandidates,
  type ControlUiAuthSource,
} from "./control-ui-auth.ts";
import { webKitHostWindow } from "./native-webkit-bridge.ts";

const RecoveryDialog = lazy(() => import("./browser-auth-recovery-dialog.tsx"));

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
      stops.forEach((stop) => stop());
      frame.remove();
      resolve();
    };
    const timeout = window.setTimeout(finish, 10_000);
    const stops = [
      listen(frame, "load", finish, { once: true }),
      listen(frame, "error", finish, { once: true }),
      listen(signal, "abort", finish, { once: true }),
    ];
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
    void withPromiseModalHost<void>({ signal: lifetime.signal, value: undefined }, (modal) => {
      const dismiss = () => {
        dismissed = true;
        modal.finish(undefined);
      };
      let update: (() => void) | undefined;
      async function signIn() {
        if (webKitHostWindow()?.webkit?.messageHandlers?.openclawGateways) {
          const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");
          if (lifetime.signal.aborted || dismissed) {
            return;
          }
          const native = nativeGatewaysCapability();
          const currentId = native?.snapshot?.currentId;
          if (native?.reconnect && currentId) {
            // The app owns a separate cookie store; a normal browser tab cannot renew it.
            native.reconnect(currentId);
            return;
          }
        }
        openedSignIn = true;
        probeResult = undefined;
        openExternalUrlSafe(root.href);
        update?.();
      }
      const content = () => {
        const [view, setView] = createStore(
          { openedSignIn, probe: pending, probeResult },
          { shallow: true },
        );
        update = () =>
          setView((draft) => {
            draft.openedSignIn = openedSignIn;
            draft.probe = pending;
            draft.probeResult = probeResult;
          });
        return (
          <Errored
            fallback={(_error, reset) => (
              <openclaw-modal-dialog
                label={t("connection.browserSignIn.title")}
                description={t("connection.browserSignIn.description")}
                onModal-cancel={dismiss}
              >
                <div class="exec-approval-card">
                  <div class="exec-approval-title">{t("connection.browserSignIn.title")}</div>
                  <p role="alert">{t("lazyView.errorTitle")}</p>
                  <openclaw-modal-actions class="exec-approval-actions">
                    <button class="btn" onClick={dismiss}>
                      {t("connection.browserSignIn.dismiss")}
                    </button>
                    <button class="btn" onClick={() => reset()}>
                      {t("common.retry")}
                    </button>
                    <button class="btn primary" onClick={() => void signIn()}>
                      {t("connection.browserSignIn.action")}
                    </button>
                  </openclaw-modal-actions>
                </div>
              </openclaw-modal-dialog>
            )}
          >
            <Loading>
              <RecoveryDialog
                view={view}
                readProbeResult={() => probeResult}
                onSignIn={() => void signIn()}
                onCheck={() => void check(true)}
                onDismiss={dismiss}
              />
            </Loading>
          </Errored>
        );
      };
      dialog = { close: () => modal.finish(undefined), update: () => update?.() };
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

  const stopFailures = bindBrowserHttpFailures((url) => {
    const request = URL.parse(url, window.location.href);
    if (request?.origin === root.origin && request.pathname.startsWith(root.pathname)) {
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
  // The recovery lifetime owns both pending HTTP work and its document listeners.
  const options = { signal: lifetime.signal };
  if (serviceWorker) {
    listen(serviceWorker, "message", onWorkerMessage, options);
  }
  listen(window, "focus", onFocus, options);
  listen(document, "visibilitychange", onVisibilityChange, options);
  return () => {
    lifetime.abort();
    stopFailures();
  };
}
