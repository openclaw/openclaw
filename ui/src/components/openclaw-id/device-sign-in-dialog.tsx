// Sign in with OpenClaw ID over a personal sign-in (Tailscale, a trusted proxy), where the
// issuer cannot redirect back to this origin: the Gateway starts a device sign-in, this
// dialog shows its code and a link to the issuer, and the Gateway polls until the user
// confirms. The account only proves which OpenClaw ID this browser holds.
import "./owner-devices-dialog.css";
import { createSignal, onSettled, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import {
  beginOpenClawIdDeviceSignIn,
  finishOpenClawIdDeviceSignIn,
  type OpenClawIdDeviceSignIn,
  type OpenClawIdLinkOutcome,
} from "../../lib/openclaw-id/device-sign-in.ts";
import { openClawIdFeatureSignal } from "../../lib/openclaw-id/feature-lifetime.ts";
import type { OpenClawIdSignedIn } from "../../lib/openclaw-id/types.ts";
import { openClawIdUiError, type OpenClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { IconButton } from "../solid/icon-button.tsx";
import { OpenClawIdErrorMessage } from "./error-message.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerOpenClawIdEnglish);

/**
 * Resolves with the account once confirmed, or null when closed first. Without `link` it
 * also says so; with `link` the Gateway links the account to this profile and the caller
 * reports the outcome.
 */
export function showDeviceSignInDialog(params: {
  client: GatewayBrowserClient;
  basePath: string;
  link?: boolean;
}): Promise<{ signedIn: OpenClawIdSignedIn; link?: OpenClawIdLinkOutcome } | null> {
  // Closes when the feature turns off.
  const lifetime = { signal: openClawIdFeatureSignal(), value: null };
  return withPromiseModalHost<{
    signedIn: OpenClawIdSignedIn;
    link?: OpenClawIdLinkOutcome;
  } | null>(lifetime, (modal) => {
    modal.render(() => {
      const [started, setStarted] = createSignal<OpenClawIdDeviceSignIn | null>(null);
      const [error, setError] = createSignal<OpenClawIdUiError | null>(null);
      onSettled(() => {
        // Closing the dialog stops polling; the Gateway forgets the code when it expires.
        const stop = new AbortController();
        void (async () => {
          try {
            const code = await beginOpenClawIdDeviceSignIn(params.client);
            stop.signal.throwIfAborted();
            setStarted(code);
            const done = await finishOpenClawIdDeviceSignIn({
              client: params.client,
              started: code,
              basePath: params.basePath,
              signal: stop.signal,
              link: params.link,
            });
            if (!params.link) {
              showToast({
                severity: "success",
                message: t("openclawId.signedIn", {
                  account: done.signedIn.email ?? t("openclawId.accountFallback"),
                }),
              });
            }
            modal.finish(done);
          } catch (cause) {
            if (!stop.signal.aborted && !modal.settled) {
              setError(openClawIdUiError(cause, "signIn"));
            }
          }
        })();
        return () => stop.abort();
      });
      return (
        <openclaw-modal-dialog
          class="openclaw-id-owner-dialog openclaw-id-owner-dialog--approval"
          label={t("openclawId.deviceSignInTitle")}
          onModal-cancel={() => modal.finish(null)}
        >
          <div class="exec-approval-card openclaw-id-devices">
            <h2 class="openclaw-id-devices__title">{t("openclawId.deviceSignInTitle")}</h2>
            <IconButton
              class="openclaw-id-devices__close"
              icon="x"
              label={t("common.close")}
              tooltip={false}
              onClick={() => modal.finish(null)}
            />
            <Show
              when={error()}
              fallback={
                <>
                  <p class="openclaw-id-devices__description">{t("openclawId.deviceSignInBody")}</p>
                  <div class="openclaw-id-approval__number" aria-live="polite">
                    <Show
                      when={started()}
                      fallback={
                        <span class="openclaw-id-approval__waiting">
                          <span class="btn__spinner" aria-hidden="true" />
                        </span>
                      }
                    >
                      {(code) => <span class="mono">{code().userCode}</span>}
                    </Show>
                  </div>
                  <Show when={started()}>
                    {(code) => (
                      <>
                        <span class="openclaw-id-approval__waiting">
                          <span class="btn__spinner" aria-hidden="true" />
                          {t("openclawId.deviceSignInWaiting")}
                        </span>
                        <openclaw-modal-actions class="exec-approval-actions">
                          <button type="button" class="btn" onClick={() => modal.finish(null)}>
                            {t("common.cancel")}
                          </button>
                          <a
                            class="btn primary"
                            href={code().verificationUriComplete ?? code().verificationUri}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t("openclawId.deviceSignInOpen")}
                          </a>
                        </openclaw-modal-actions>
                      </>
                    )}
                  </Show>
                </>
              }
            >
              {(message) => (
                <div class="openclaw-id-devices__error" role="alert">
                  <OpenClawIdErrorMessage error={message()} />
                </div>
              )}
            </Show>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
