import "../../styles/exec-approval-card.css";
// "Reset owner access" (owner reset, enrollment.md "Owner reset") from Settings → OpenClaw ID,
// only on the computer that runs the claw. The owner types the claw's name, a new recovery kit
// (S', R') is made in this browser and shown once, and only after it is saved does R' sign the
// new binding and this browser's owner device. The Gateway gets public keys and signed
// statements; it removes everyone else and publishes the new root with its RootReset.
import { createSignal, Match, Switch } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import {
  announceOwnerDeviceKey,
  ensureOwnerDeviceSigner,
} from "../../lib/openclaw-id/device-key.ts";
import type { RecoveryKitDetails } from "../../lib/openclaw-id/kit-export.ts";
import {
  createOpenClawIdCeremony,
  type OpenClawIdResetPreparation,
} from "../../lib/openclaw-id/link.ts";
import type { OpenClawIdPublication } from "../../lib/openclaw-id/types.ts";
import { openClawIdUiError, type OpenClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { clawNameFromHostname } from "./claw-name.ts";
import { OpenClawIdErrorMessage } from "./error-message.tsx";
import { RecoveryKitForm } from "./recovery-kit-form.tsx";
import { RecoveryKitPanel } from "./recovery-kit-panel.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerOpenClawIdEnglish);

type Step =
  | { kind: "confirm" }
  | { kind: "kit"; details: RecoveryKitDetails }
  | { kind: "resetting" }
  | { kind: "failed"; error: OpenClawIdUiError };

/** Resolves true once the Gateway confirmed the reset, false when closed before it. */
export function showResetOwnerDialog(params: {
  client: GatewayBrowserClient;
  accountEmail?: string | null;
}): Promise<boolean> {
  const ceremony = createOpenClawIdCeremony();
  return withPromiseModalHost<boolean>(undefined, async (modal) => {
    // What R' signs; refused (for example over the tunnel) before anything is shown.
    const prep = await params.client.request<OpenClawIdResetPreparation>("openclawId.authority", {
      action: "reset_prepare",
    });
    const name = clawNameFromHostname(prep.hostname);
    modal.render(() => {
      const [step, setStep] = createSignal<Step>({ kind: "confirm" });
      const [typed, setTyped] = createSignal("");
      const [saved, setSaved] = createSignal(false);
      const finish = (reset: boolean) => {
        ceremony.discard();
        modal.finish(reset);
      };
      const makeKit = async () => {
        const kit = await ceremony.createKit();
        if (!modal.settled) {
          setSaved(false);
          setStep({
            kind: "kit",
            details: {
              kit,
              hostname: prep.hostname,
              owner: params.accountEmail ?? null,
              createdAt: new Date(),
            },
          });
        }
      };
      // The kit is saved by now: if the answer is lost after the Gateway committed, it is the
      // claw's only recovery kit, so the dialog says so instead of offering another.
      const reset = async () => {
        if (modal.settled) {
          return;
        }
        setStep({ kind: "resetting" });
        try {
          const device = await ensureOwnerDeviceSigner(prep.claw_id);
          const signed = await ceremony.signReset(prep, device, t("openclawId.thisBrowser"));
          ceremony.discard();
          const result = await params.client.request<{ publication: OpenClawIdPublication | null }>(
            "openclawId.authority",
            { action: "reset_commit", ...signed },
          );
          announceOwnerDeviceKey();
          showToast({
            severity: "success",
            message: t(
              result.publication?.state === "published"
                ? "openclawId.resetDone"
                : "openclawId.resetDoneUnpublished",
            ),
          });
          finish(true);
        } catch (error) {
          ceremony.discard();
          const failure = openClawIdUiError(error, "setup");
          // A refusal names its code and changed nothing; any other failure may follow a commit.
          const refused =
            error instanceof Error &&
            "details" in error &&
            typeof error.details === "object" &&
            error.details !== null &&
            "code" in error.details;
          setStep({
            kind: "failed",
            error: refused
              ? failure
              : {
                  message: t("openclawId.resetUncertain"),
                  detail: failure.detail || failure.message,
                },
          });
        }
      };
      const close = (event?: Event) => {
        if (step().kind === "resetting") {
          event?.preventDefault();
          return;
        }
        finish(step().kind === "failed");
      };
      const kitStep = () => {
        const current = step();
        return current.kind === "kit" ? current : false;
      };
      const failedStep = () => {
        const current = step();
        return current.kind === "failed" ? current : false;
      };
      return (
        <openclaw-modal-dialog label={t("openclawId.resetOwnerAccess")} onModal-cancel={close}>
          <div class="exec-approval-card openclaw-id-reset">
            <h2>{t("openclawId.resetOwnerAccess")}</h2>
            <Switch>
              <Match when={step().kind === "confirm"}>
                <p>
                  {t("openclawId.resetBody", {
                    devices: String(prep.removes.ownerDevices),
                    members: String(prep.removes.members),
                    nodes: String(prep.removes.nodes),
                    invites: String(prep.removes.invites),
                    host: prep.hostname,
                  })}
                </p>
                <form
                  id="openclaw-id-reset-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (typed().trim() === name) {
                      void makeKit();
                    }
                  }}
                >
                  <label class="field">
                    <span>{t("openclawId.resetConfirmLabel", { name })}</span>
                    <input
                      type="text"
                      name="claw-name"
                      autocomplete="off"
                      spellcheck="false"
                      value={typed()}
                      onInput={(event) => setTyped(event.currentTarget.value)}
                    />
                  </label>
                </form>
                <openclaw-modal-actions class="exec-approval-actions">
                  <button type="button" class="btn" onClick={() => close()}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="submit"
                    form="openclaw-id-reset-form"
                    class="btn danger"
                    disabled={typed().trim() !== name}
                  >
                    {t("openclawId.resetMakeKit")}
                  </button>
                </openclaw-modal-actions>
              </Match>
              <Match when={kitStep()}>
                {(current) => (
                  <>
                    <p>{t("openclawId.resetKitBody")}</p>
                    <RecoveryKitForm
                      details={current().details}
                      accountEmail={params.accountEmail}
                      saved={saved()}
                      onContinue={() => void reset()}
                    >
                      <RecoveryKitPanel
                        details={current().details}
                        accountEmail={params.accountEmail}
                        saved={saved()}
                        onSaved={setSaved}
                      />
                      <openclaw-modal-actions class="exec-approval-actions">
                        <button type="button" class="btn" onClick={() => close()}>
                          {t("common.cancel")}
                        </button>
                        <button type="submit" class="btn danger" disabled={!saved()}>
                          {t("openclawId.resetCommit")}
                        </button>
                      </openclaw-modal-actions>
                    </RecoveryKitForm>
                  </>
                )}
              </Match>
              <Match when={step().kind === "resetting"}>
                <p role="status">{t("common.loading")}</p>
              </Match>
              <Match when={failedStep()}>
                {(current) => (
                  <>
                    <div class="callout danger" role="alert">
                      <OpenClawIdErrorMessage error={current().error} />
                    </div>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn" onClick={() => close()}>
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
  }).finally(() => ceremony.discard());
}
