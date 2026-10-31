import "../../styles/secret-reveal.css";
import { createSignal, Match, Show, Switch } from "solid-js";
import type { OwnerKeyRegenerationPreparation } from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateOwnerDeviceKey, saveOwnerDeviceKey } from "../../lib/openclaw-id/device-key.ts";
import type { RecoveryKitDetails } from "../../lib/openclaw-id/kit-export.ts";
import { createOpenClawIdCeremony } from "../../lib/openclaw-id/link.ts";
import type { OpenClawIdSignedIn } from "../../lib/openclaw-id/types.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { Icon } from "../solid/icon.tsx";
import { RecoveryKitPanel } from "./recovery-kit-panel.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);

type Step =
  | { kind: "confirm" }
  | { kind: "kit"; preparation: OwnerKeyRegenerationPreparation; details: RecoveryKitDetails }
  | { kind: "working" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Parses the optional expiry field (whole days from now) into Unix seconds; null
 * means no expiry. Returns undefined for anything that is not a positive number.
 */
export function regenerationExpiry(
  daysText: string,
  nowMs = Date.now(),
): number | null | undefined {
  const trimmed = daysText.trim();
  if (!trimmed) {
    return null;
  }
  const days = Number(trimmed);
  if (!Number.isInteger(days) || days <= 0) {
    return undefined;
  }
  return Math.floor(nowMs / 1000) + days * 86_400;
}

/**
 * "Regenerate owner key" (OCF-323, owner-key spec section 8.3), shown only on a
 * direct-loopback Control UI. The owner confirms what stops working, optionally
 * sets an expiry for this browser's new certificate, then the browser asks the
 * Gateway what to sign (prepare_regeneration), creates the new recovery kit and
 * shows it once. After the owner saves it, the browser signs its own enrollment
 * and the new binding with the new root and sends only those statements
 * (regenerate); the new kit and root never leave this page. This browser then
 * becomes the only owner device. Resolves true once the key is replaced.
 */
export function showRegenerateOwnerKeyDialog(params: {
  client: GatewayBrowserClient;
  signedIn?: OpenClawIdSignedIn | null;
}): Promise<boolean> {
  const ceremony = createOpenClawIdCeremony();
  return withPromiseModalHost<boolean>(undefined, (modal) => {
    modal.render(() => {
      const [step, setStep] = createSignal<Step>({ kind: "confirm" });
      const [saved, setSaved] = createSignal(false);
      const [expiryDays, setExpiryDays] = createSignal("");
      const expiry = () => regenerationExpiry(expiryDays());
      const finish = (regenerated: boolean) => {
        ceremony.discard();
        modal.finish(regenerated);
      };
      const fail = (error: unknown) => {
        ceremony.discard();
        setStep({ kind: "error", message: formatUiError(error) });
      };
      // Asks what to sign, then creates and shows the new kit.
      const start = async () => {
        try {
          const preparation = await params.client.request<OwnerKeyRegenerationPreparation>(
            "openclawId.authority",
            { action: "prepare_regeneration" },
          );
          const kit = await ceremony.createKit();
          const owner = params.signedIn?.email ?? params.signedIn?.name ?? null;
          setStep({
            kind: "kit",
            preparation,
            details: { kit, hostname: preparation.hostname, owner, createdAt: new Date() },
          });
        } catch (error) {
          fail(error);
        }
      };
      // Signs with the new root, sends the statements and keeps this browser's new key.
      const regenerate = async (preparation: OwnerKeyRegenerationPreparation) => {
        setStep({ kind: "working" });
        try {
          const device = await generateOwnerDeviceKey();
          const signed = await ceremony.signRegeneration(
            preparation,
            device.signer,
            t("openclawId.thisBrowser"),
            expiry() ?? null,
          );
          // The new root is not needed once the statements are signed.
          ceremony.discard();
          await params.client.request("openclawId.authority", { action: "regenerate", ...signed });
          await saveOwnerDeviceKey(preparation.claw_id, device.pair);
          setStep({ kind: "done" });
        } catch (error) {
          fail(error);
        }
      };
      const cancel = (event: Event) => {
        if (step().kind === "working") {
          event.preventDefault();
          return;
        }
        finish(step().kind === "done");
      };
      return (
        <openclaw-modal-dialog
          label={t("openclawId.regenTitle")}
          description={t("openclawId.regenDescription")}
          onModal-cancel={cancel}
        >
          <div class="exec-approval-card">
            <div class="secret-reveal__header">
              <Show when={step().kind === "done"}>
                <span class="secret-reveal__status" aria-hidden="true">
                  <Icon name="check" />
                </span>
              </Show>
              <div class="exec-approval-title">{t("openclawId.regenTitle")}</div>
            </div>
            <Switch>
              <Match when={step().kind === "confirm"}>
                <div class="secret-reveal__body">
                  <p>{t("openclawId.regenBody")}</p>
                </div>
                <div class="callout danger" role="note">
                  {t("openclawId.regenConsequences")}
                </div>
                <label class="field">
                  <span>{t("openclawId.regenExpiry")}</span>
                  <input
                    type="number"
                    min="1"
                    inputmode="numeric"
                    value={expiryDays()}
                    onInput={(event) => setExpiryDays(event.currentTarget.value)}
                  />
                  <span class="muted">{t("openclawId.regenExpiryHint")}</span>
                </label>
                <openclaw-modal-actions class="exec-approval-actions">
                  <button type="button" class="btn" onClick={() => finish(false)}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    class="btn danger"
                    disabled={expiry() === undefined}
                    onClick={() => void start()}
                  >
                    {t("openclawId.regenConfirm")}
                  </button>
                </openclaw-modal-actions>
              </Match>
              <Match when={step().kind === "kit" && (step() as Extract<Step, { kind: "kit" }>)}>
                {(kitStep) => (
                  <>
                    <div class="secret-reveal__body">
                      <p>
                        <strong>{t("openclawId.kitTitle")}</strong>
                      </p>
                      <p>{t("openclawId.regenKitBody")}</p>
                    </div>
                    <RecoveryKitPanel
                      details={kitStep().details}
                      saved={saved()}
                      onSaved={setSaved}
                    />
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn" onClick={() => finish(false)}>
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        class="btn primary"
                        disabled={!saved()}
                        onClick={() => void regenerate(kitStep().preparation)}
                      >
                        {t("openclawId.regenReplace")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
              <Match when={step().kind === "working"}>
                <p class="muted" role="status">
                  {t("openclawId.regenWorking")}
                </p>
              </Match>
              <Match when={step().kind === "done"}>
                <div class="secret-reveal__body">
                  <p>{t("openclawId.regenDone")}</p>
                </div>
                <openclaw-modal-actions class="exec-approval-actions">
                  <button type="button" class="btn primary" autofocus onClick={() => finish(true)}>
                    {t("openclawId.done")}
                  </button>
                </openclaw-modal-actions>
              </Match>
              <Match when={step().kind === "error" && (step() as Extract<Step, { kind: "error" }>)}>
                {(failed) => (
                  <>
                    <div class="callout danger" role="alert">
                      {failed().message}
                    </div>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn" autofocus onClick={() => finish(false)}>
                        {t("common.close")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
            </Switch>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
