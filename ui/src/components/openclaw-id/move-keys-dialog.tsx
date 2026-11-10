// "Move to new keys" from the account menu, on the computer that runs the claw: the recovery
// code typed here signs the new binding in this browser (lib/openclaw-id/rebind.ts), the
// owner confirms the key fingerprints, and the Gateway stores it and publishes the new keys.
import "./move-keys-dialog.css";
import { createSignal, Match, onSettled, Show, Switch } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import {
  guardOpenClawIdAccount,
  subscribeOpenClawIdAccount,
} from "../../lib/openclaw-id/account.ts";
import { openClawIdFeatureSignal } from "../../lib/openclaw-id/feature-lifetime.ts";
import {
  cancelRebind,
  commitRebind,
  prepareRebind,
  type RebindPlan,
  type RebindRefusal,
} from "../../lib/openclaw-id/rebind.ts";
import type { OpenClawIdSignedIn } from "../../lib/openclaw-id/types.ts";
import { openClawIdUiError, type OpenClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { showToast } from "../../lib/toast.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { OpenClawIdErrorMessage } from "./error-message.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerOpenClawIdEnglish);

/** Plain copy for a signing refusal; nothing was signed. */
export function rebindRefusalMessage(refusal: RebindRefusal, hostname: string): string {
  switch (refusal.code) {
    case "bad_kit":
      return t("openclawId.moveKeysBadKit");
    case "wrong_kit":
      return t("openclawId.moveKeysWrongKit", { fp: refusal.kitRoot, host: hostname });
    case "published_unverifiable":
      return t("openclawId.moveKeysUnverifiable");
    case "published_unavailable":
    case "binding_seq_too_low":
      return t("openclawId.moveKeysUnavailable");
    default:
      return refusal satisfies never;
  }
}

function KeyRow(props: { label: string; from: string; to: string }) {
  return (
    <div class="openclaw-id-move-keys__row">
      <dt>{props.label}</dt>
      <dd>
        <span class="openclaw-id-move-keys__fp">{props.from}</span> →{" "}
        <span class="openclaw-id-move-keys__fp">{props.to}</span>
      </dd>
    </div>
  );
}

/** Resolves true once the claw moved to new keys, false when closed without moving. */
export function showMoveKeysDialog(params: {
  client: GatewayBrowserClient;
  signedIn: OpenClawIdSignedIn;
  hostname: string;
}): Promise<boolean> {
  const assertAccount = guardOpenClawIdAccount(params.signedIn);
  const feature = openClawIdFeatureSignal();
  if (feature.aborted) {
    return Promise.resolve(false);
  }
  return withPromiseModalHost<boolean>(undefined, (modal) => {
    modal.render(() => {
      const [kit, setKit] = createSignal("");
      const [plan, setPlan] = createSignal<RebindPlan | null>(null);
      const [busy, setBusy] = createSignal(false);
      const [refused, setRefused] = createSignal<string | null>(null);
      const [error, setError] = createSignal<OpenClawIdUiError | null>(null);
      const fail = (cause: unknown) => setError(openClawIdUiError(cause, "setup"));
      // Plain, not a signal: dismissal must see an operation the moment it starts. While one
      // runs the dialog stays open, so a commit's outcome is always shown, never dropped.
      let inFlight = false;
      let committing = false;
      let retired = false;
      // Byte secrets are zeroed where they are made: signRebind zeroes the kit secret S and the
      // derived seed, and R stays a non-extractable CryptoKey that is dropped. The typed code and
      // the signed binding are JS strings, which cannot be overwritten: on close they are
      // released here and scrubbed from the field, so nothing keeps them reachable.
      let input: HTMLInputElement | undefined;
      const retire = () => {
        retired = true;
        setPlan(null);
        setKit("");
        if (input) {
          input.value = "";
          input.defaultValue = "";
        }
        // Once dispatched, a commit owns settlement even after Labs or account retirement.
        if (!committing) {
          modal.finish(false);
        }
      };
      onSettled(() => {
        const unsubscribe = subscribeOpenClawIdAccount(() => {
          try {
            assertAccount();
          } catch {
            retire();
          }
        });
        const stopFeature = listen(feature, "abort", retire, { once: true });
        if (feature.aborted) {
          retire();
        }
        return () => {
          unsubscribe();
          stopFeature();
          if (input) {
            input.value = "";
            input.defaultValue = "";
          }
          setKit("");
          setPlan(null);
        };
      });
      const run = async (operation: () => Promise<void>) => {
        inFlight = true;
        setBusy(true);
        try {
          await operation();
        } finally {
          inFlight = false;
          setBusy(false);
        }
      };

      const check = (kitText: string) =>
        run(async () => {
          setRefused(null);
          setError(null);
          try {
            const result = await prepareRebind({
              client: params.client,
              signedIn: params.signedIn,
              kitText,
            });
            if (retired || modal.settled) {
              return;
            }
            if (result.ok) {
              setKit("");
              setPlan(result.plan);
            } else {
              setRefused(rebindRefusalMessage(result, params.hostname));
            }
          } catch (cause) {
            if (retired || modal.settled) {
              return;
            }
            fail(cause);
          }
        });

      const move = (current: RebindPlan) =>
        run(async () => {
          setError(null);
          try {
            if (retired || feature.aborted) {
              retire();
              return;
            }
            committing = true;
            await commitRebind(params.client, current);
          } catch (cause) {
            if (retired) {
              showToast({ severity: "error", message: openClawIdUiError(cause, "setup").message });
              modal.finish(false);
            } else {
              fail(cause);
            }
            return;
          } finally {
            committing = false;
          }
          setPlan(null);
          showToast({ severity: "success", message: t("openclawId.moveKeysDone") });
          modal.finish(true);
        });

      const close = (event?: Event) => {
        if (inFlight) {
          event?.preventDefault();
          return;
        }
        if (plan()) {
          void cancelRebind(params.client).catch(() => undefined);
        }
        setPlan(null);
        setKit("");
        modal.finish(false);
      };

      return (
        <openclaw-modal-dialog label={t("openclawId.moveToNewKeys")} onModal-cancel={close}>
          <div class="exec-approval-card openclaw-id-move-keys">
            <h2>{t("openclawId.moveToNewKeys")}</h2>
            <p>{t("openclawId.moveKeysBody", { host: params.hostname })}</p>
            <Switch>
              <Match when={plan()}>
                {(current) => (
                  <>
                    <h3>{t("openclawId.moveKeysConfirm")}</h3>
                    <dl class="openclaw-id-move-keys__keys">
                      <div class="openclaw-id-move-keys__row">
                        <dt>{t("openclawId.moveKeysRoot")}</dt>
                        <dd>
                          <span class="openclaw-id-move-keys__fp">{current().root}</span>{" "}
                          <span class="muted">{t("openclawId.moveKeysRootMatches")}</span>
                        </dd>
                      </div>
                      <KeyRow
                        label={t("openclawId.moveKeysBinding")}
                        from={String(current().bindingSeq.from)}
                        to={String(current().bindingSeq.to)}
                      />
                      <KeyRow
                        label={t("openclawId.moveKeysEndpoint")}
                        from={current().endpoint.from}
                        to={current().endpoint.to}
                      />
                      <KeyRow
                        label={t("openclawId.moveKeysGateway")}
                        from={current().gateway.from}
                        to={current().gateway.to}
                      />
                    </dl>
                  </>
                )}
              </Match>
              <Match when={!plan()}>
                <form
                  id="openclaw-id-move-keys-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void check(kit());
                  }}
                >
                  <label class="field">
                    <span>{t("openclawId.moveKeysKit")}</span>
                    <input
                      ref={(element) => (input = element)}
                      type="password"
                      name="recovery-code"
                      autocomplete="off"
                      spellcheck="false"
                      class="mono"
                      value={kit()}
                      disabled={busy()}
                      onInput={(event) => setKit(event.currentTarget.value)}
                    />
                    <small>{t("openclawId.moveKeysKitHint")}</small>
                  </label>
                </form>
              </Match>
            </Switch>
            <Show when={refused()}>
              {(message) => (
                <p class="callout danger" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <Show when={error()}>
              {(current) => (
                <div class="callout danger" role="alert">
                  <OpenClawIdErrorMessage error={current()} />
                </div>
              )}
            </Show>
            <openclaw-modal-actions class="exec-approval-actions">
              <button type="button" class="btn" disabled={busy()} onClick={close}>
                {t("common.cancel")}
              </button>
              <Show
                when={plan()}
                fallback={
                  <button
                    type="submit"
                    form="openclaw-id-move-keys-form"
                    class="btn primary"
                    disabled={busy() || !kit().trim()}
                  >
                    {t("openclawId.moveKeysCheck")}
                  </button>
                }
              >
                {(current) => (
                  <button
                    type="button"
                    class="btn primary"
                    disabled={busy()}
                    onClick={() => void move(current())}
                  >
                    {t("openclawId.moveKeysMove")}
                  </button>
                )}
              </Show>
            </openclaw-modal-actions>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
