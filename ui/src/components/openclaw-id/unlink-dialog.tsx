import "../../styles/exec-approval-card.css";
// "Unlink from OpenClaw ID" from the account menu, on the computer that runs the claw. The
// warning shows the Gateway's live counts of the people and devices that lose access, that the
// address stops working at once and that the name is retired for good, before anything happens.
import { createSignal, onSettled, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { openClawIdFeatureSignal } from "../../lib/openclaw-id/feature-lifetime.ts";
import { openClawIdUiError, type OpenClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { showToast } from "../../lib/toast.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { clawNameFromHostname } from "./claw-name.ts";
import { OpenClawIdErrorMessage } from "./error-message.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerOpenClawIdEnglish);

/** The Gateway's `unlink_preview` answer: who and what loses access. */
export type UnlinkPreview = {
  claw_id: string;
  hostname: string;
  people: number;
  devices: number;
  ownerDevices: number;
  memberDevices: number;
  nodes: number;
};

/** The Gateway's `unlink` answer. */
type UnlinkResult = {
  hostname: string;
  discovery: "confirmed" | "local_only" | "pending" | "refused" | "unconfigured";
  discoveryCode?: string;
  followUpError?: string;
};

/** "N people and M devices lose access now…", from the live counts. */
export function unlinkLosesAccess(preview: Pick<UnlinkPreview, "people" | "devices">): string {
  return t("openclawId.unlinkLosesAccess", {
    people:
      preview.people === 1
        ? t("openclawId.unlinkPeopleOne")
        : t("openclawId.unlinkPeopleMany", { count: String(preview.people) }),
    devices:
      preview.devices === 1
        ? t("openclawId.unlinkDevicesOne")
        : t("openclawId.unlinkDevicesMany", { count: String(preview.devices) }),
  });
}

/** Resolves true once the claw is unlinked, false when closed without unlinking. */
export function showUnlinkDialog(params: {
  client: GatewayBrowserClient;
  hostname: string;
}): Promise<boolean> {
  const feature = openClawIdFeatureSignal();
  if (feature.aborted) {
    return Promise.resolve(false);
  }
  return withPromiseModalHost<boolean>(undefined, (modal) => {
    modal.render(() => {
      const [preview, setPreview] = createSignal<UnlinkPreview | null>(null);
      const [busy, setBusy] = createSignal(true);
      const [error, setError] = createSignal<OpenClawIdUiError | null>(null);
      // Plain, not a signal: dismissal must see an unlink the moment it starts. While it runs
      // the dialog stays open, so its outcome is always shown.
      let unlinking = false;
      onSettled(() => {
        const stopFeature = listen(
          feature,
          "abort",
          () => {
            if (!unlinking) {
              modal.finish(false);
            }
          },
          { once: true },
        );
        params.client
          .request<UnlinkPreview>("openclawId.authority", { action: "unlink_preview" })
          .then(
            (result) => {
              if (!modal.settled) {
                setPreview(result);
              }
            },
            (cause: unknown) => {
              if (!modal.settled) {
                setError(openClawIdUiError(cause, "setup"));
              }
            },
          )
          .finally(() => setBusy(false));
        return stopFeature;
      });

      const unlink = async (clawId: string) => {
        unlinking = true;
        setBusy(true);
        setError(null);
        let result: UnlinkResult;
        try {
          result = await params.client.request<UnlinkResult>("openclawId.authority", {
            action: "unlink",
            clawId,
          });
        } catch (cause) {
          setError(openClawIdUiError(cause, "setup"));
          return;
        } finally {
          unlinking = false;
          setBusy(false);
        }
        const done = t("openclawId.unlinkDone", { host: result.hostname });
        const description =
          result.followUpError !== undefined
            ? t("openclawId.unlinkFollowUpFailed")
            : result.discovery === "pending"
              ? t("openclawId.unlinkPending")
              : result.discovery === "refused"
                ? t("openclawId.unlinkRefused")
                : undefined;
        showToast(
          description === undefined
            ? {
                severity: "success",
                message: done,
                ...(result.discovery === "local_only"
                  ? { description: t("openclawId.unlinkLocalOnly") }
                  : {}),
              }
            : {
                severity: "warning",
                message: done,
                description,
                ...(result.followUpError === undefined ? {} : { detail: result.followUpError }),
              },
        );
        modal.finish(true);
      };

      const close = (event?: Event) => {
        if (unlinking) {
          event?.preventDefault();
          return;
        }
        modal.finish(false);
      };

      const host = () => preview()?.hostname ?? params.hostname;
      return (
        <openclaw-modal-dialog label={t("openclawId.unlinkFromOpenClawId")} onModal-cancel={close}>
          <div class="exec-approval-card openclaw-id-unlink">
            <h2>{t("openclawId.unlinkTitle", { host: host() })}</h2>
            <Show
              when={preview()}
              fallback={
                <Show when={!error()}>
                  <p class="muted" role="status">
                    {t("openclawId.unlinkLoading")}
                  </p>
                </Show>
              }
            >
              {(current) => (
                <ul class="openclaw-id-unlink__warning" data-testid="openclaw-id-unlink-warning">
                  <li>{unlinkLosesAccess(current())}</li>
                  <li>{t("openclawId.unlinkAddressStops", { host: current().hostname })}</li>
                  <li>
                    {t("openclawId.unlinkNameRetired", {
                      name: clawNameFromHostname(current().hostname),
                    })}
                  </li>
                  <li>{t("openclawId.unlinkLocalStays")}</li>
                </ul>
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
              <button type="button" class="btn" disabled={busy() && unlinking} onClick={close}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                class="btn danger"
                disabled={busy() || !preview()}
                onClick={() => {
                  const current = preview();
                  if (current) {
                    void unlink(current.claw_id);
                  }
                }}
              >
                {t("openclawId.unlinkConfirm")}
              </button>
            </openclaw-modal-actions>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
