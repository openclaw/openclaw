// "Your devices" from the account menu (OCF-280): the claw's active owner
// devices, which one is this browser, and Revoke for the others. Revoking also
// ends the devices the revoked one approved; the dialog names them first.
import { createSignal, For, Show } from "solid-js";
import {
  displayFingerprint,
  fingerprint,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { openClawIdAccount } from "../../lib/openclaw-id/account.ts";
import {
  devicesApprovedBy,
  signOwnerDeviceRevocation,
  thisOwnerDevice,
} from "../../lib/openclaw-id/owner-devices.ts";
import type {
  OpenClawIdStatusResult,
  OpenClawIdOwnerDevice,
  OpenClawIdPeopleLink,
} from "../../lib/openclaw-id/types.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { showOwnerApprovalDialog } from "./owner-approval-dialog.tsx";
import { showRegenerateOwnerKeyDialog } from "./regenerate-owner-key-dialog.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerOpenClawIdEnglish);

type Link = OpenClawIdPeopleLink;

// Reads the owner-only link state (devices change after every revocation).
async function readLink(client: GatewayBrowserClient): Promise<Link> {
  return (await client.request<{ link: Link }>("openclawId.people", {})).link;
}

// The owner key's display fingerprint, as printed on the recovery kit.
async function ownerFingerprint(link: Link): Promise<string | null> {
  try {
    return link.rootPub ? displayFingerprint(await fingerprint(link.rootPub as never)) : null;
  } catch {
    return null;
  }
}

/** One device row with an inline, explained Revoke. */
function DeviceRow(props: {
  device: OpenClawIdOwnerDevice;
  isThisBrowser: boolean;
  approved: OpenClawIdOwnerDevice[];
  canRevoke: boolean;
  busy: boolean;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = createSignal(false);
  return (
    <div role="listitem" class="row openclaw-id-devices__row">
      <div class="stack openclaw-id-devices__text">
        <strong class="openclaw-id-devices__label">
          {props.device.label}
          <Show when={props.isThisBrowser}>
            <span class="chip">{t("openclawId.thisBrowser")}</span>
          </Show>
        </strong>
        <div class="muted openclaw-id-devices__hint">
          {props.device.peerKeys.length > 0
            ? t("openclawId.deviceRemote")
            : t("openclawId.deviceLocal")}
        </div>
        <Show when={confirming()}>
          <p class="muted openclaw-id-devices__hint" role="note">
            {props.approved.length > 0
              ? t("openclawId.revokeCascade", {
                  devices: props.approved.map((device) => device.label).join(", "),
                })
              : t("openclawId.revokeOne")}
          </p>
        </Show>
      </div>
      <Show when={props.canRevoke && !props.isThisBrowser}>
        <Show
          when={confirming()}
          fallback={
            <button
              type="button"
              class="btn btn--sm"
              disabled={props.busy}
              onClick={() => setConfirming(true)}
            >
              {t("openclawId.revoke")}
            </button>
          }
        >
          <button type="button" class="btn btn--sm" onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class="btn btn--sm danger"
            disabled={props.busy}
            onClick={() => props.onRevoke()}
          >
            {t("openclawId.revokeConfirm", { device: props.device.label })}
          </button>
        </Show>
      </Show>
    </div>
  );
}

/**
 * Shows the claw's owner devices. Only an owner device (a browser holding its
 * key) can revoke; this browser can't revoke itself. Resolves when closed.
 */
export function showOwnerDevicesDialog(params: { client: GatewayBrowserClient }): Promise<void> {
  return withPromiseModalHost<void>(undefined, (modal) => {
    modal.render(() => {
      const [link, setLink] = createSignal<Link | null>(null);
      const [ownPub, setOwnPub] = createSignal<string | null>(null);
      const [ownerFp, setOwnerFp] = createSignal<string | null>(null);
      const [localOperator, setLocalOperator] = createSignal(false);
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal<string | null>(null);
      const refresh = async () => {
        try {
          const [next, status] = await Promise.all([
            readLink(params.client),
            params.client.request<OpenClawIdStatusResult>("openclawId.status", {}),
          ]);
          setLocalOperator(status.channel === "local_operator" && next.linked);
          setOwnPub((await thisOwnerDevice(next).catch(() => undefined))?.devicePub ?? null);
          setOwnerFp(await ownerFingerprint(next));
          setLink(next);
        } catch (failure) {
          setError(formatUiError(failure));
        }
      };
      const revoke = async (device: OpenClawIdOwnerDevice) => {
        const current = link();
        if (!current || busy()) {
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const statement = await signOwnerDeviceRevocation(current, device);
          await params.client.request("openclawId.authority", { action: "submit", statement });
        } catch (failure) {
          setError(formatUiError(failure));
        } finally {
          setBusy(false);
          await refresh();
        }
      };
      // Close this dialog before opening regeneration so modal focus has one owner.
      const regenerate = () => {
        modal.finish(undefined);
        void showRegenerateOwnerKeyDialog({
          client: params.client,
          signedIn: openClawIdAccount(),
        }).catch((failure: unknown) => showToast({ message: formatUiError(failure) }));
      };
      void refresh();
      const devices = () => link()?.ownerDevices ?? [];
      return (
        <openclaw-modal-dialog
          label={t("openclawId.yourDevices")}
          description={t("openclawId.yourDevicesBody")}
          onModal-cancel={() => modal.finish(undefined)}
        >
          <div class="exec-approval-card openclaw-id-devices">
            <div class="exec-approval-title">{t("openclawId.yourDevices")}</div>
            <p class="muted openclaw-id-devices__hint">{t("openclawId.yourDevicesBody")}</p>
            <Show when={error()}>
              {(message) => (
                <div class="callout danger" role="alert">
                  {message()}
                </div>
              )}
            </Show>
            <Show when={link() && !ownPub()}>
              <div class="callout info" role="note">
                {t("openclawId.notOwnerDevice")}
              </div>
            </Show>
            <div
              class="list openclaw-id-devices__list"
              role="list"
              style={{ "max-height": "50vh", "overflow-y": "auto" }}
            >
              <For each={devices()}>
                {(device) => (
                  <DeviceRow
                    device={device}
                    isThisBrowser={device.devicePub === ownPub()}
                    approved={devicesApprovedBy(devices(), device)}
                    canRevoke={Boolean(ownPub())}
                    busy={busy()}
                    onRevoke={() => void revoke(device)}
                  />
                )}
              </For>
            </div>
            <Show when={localOperator()}>
              <button
                type="button"
                class="btn"
                onClick={() => {
                  modal.finish(undefined);
                  void showOwnerApprovalDialog({ client: params.client });
                }}
              >
                {t("openclawId.approveNewDevice")}
              </button>
            </Show>
            <Show when={ownerFp()}>
              {(fp) => (
                <p class="muted openclaw-id-devices__hint">
                  {t("openclawId.recoveryKitLine", { fingerprint: fp() })}
                </p>
              )}
            </Show>
            <Show when={localOperator() && link()?.frozen}>
              <div class="callout danger" role="alert">
                {t("openclawId.frozenAlert")}
              </div>
            </Show>
            <openclaw-modal-actions class="exec-approval-actions">
              <Show when={localOperator()}>
                <button type="button" class="btn" disabled={busy()} onClick={regenerate}>
                  {t("openclawId.regenerateOwnerKey")}
                </button>
              </Show>
              <button
                type="button"
                class="btn primary"
                autofocus
                onClick={() => modal.finish(undefined)}
              >
                {t("common.close")}
              </button>
            </openclaw-modal-actions>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
