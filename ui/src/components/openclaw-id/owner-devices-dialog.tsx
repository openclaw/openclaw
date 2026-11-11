// "Your devices" from the account menu (OCF-280): the claw's active owner
// devices, who approved each one, which one is this browser, and Revoke for the
// others. Revoking also removes the devices the revoked one approved; the dialog
// names them first. Device keys are per claw, so a removal applies to this claw.
import "./owner-devices-dialog.css";
import { createSignal, For, Show } from "solid-js";
import {
  displayFingerprint,
  fingerprint,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { openClawIdFeatureSignal } from "../../lib/openclaw-id/feature-lifetime.ts";
import {
  approverOf,
  devicesApprovedBy,
  signOwnerDeviceRevocation,
  thisOwnerDevice,
} from "../../lib/openclaw-id/owner-devices.ts";
import type {
  OpenClawIdStatusResult,
  OpenClawIdOwnerDevice,
  OpenClawIdPeopleLink,
} from "../../lib/openclaw-id/types.ts";
import { openClawIdUiError, type OpenClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { OpenClawIdErrorMessage } from "./error-message.tsx";
import { showOwnerApprovalDialog } from "./owner-approval-dialog.tsx";

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
    // SAFETY: fingerprint rejects a malformed key, which the catch below turns into null.
    return link.rootPub ? displayFingerprint(await fingerprint(link.rootPub as never)) : null;
  } catch {
    return null;
  }
}

/** One device row with an inline, explained Revoke. */
function DeviceRow(props: {
  device: OpenClawIdOwnerDevice;
  isThisBrowser: boolean;
  approver: ReturnType<typeof approverOf>;
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
        <div class="muted openclaw-id-devices__hint">
          {props.approver.kind === "kit"
            ? t("openclawId.approvedByKit")
            : props.approver.kind === "device"
              ? t("openclawId.approvedByDevice", { device: props.approver.label })
              : t("openclawId.approvedByRemoved")}
        </div>
        <Show when={confirming()}>
          <p class="muted openclaw-id-devices__hint" role="note">
            {props.approved.length > 0
              ? t("openclawId.revokeCascade", {
                  device: props.device.label,
                  devices: props.approved.map((device) => device.label).join(", "),
                })
              : t("openclawId.revokeOne", { device: props.device.label })}
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
  // Closes when the feature turns off.
  const lifetime = { signal: openClawIdFeatureSignal(), value: undefined };
  return withPromiseModalHost<void>(lifetime, (modal) => {
    modal.render(() => {
      const [link, setLink] = createSignal<Link | null>(null);
      const [ownPub, setOwnPub] = createSignal<string | null>(null);
      const [ownerFp, setOwnerFp] = createSignal<string | null>(null);
      const [localOperator, setLocalOperator] = createSignal(false);
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal<OpenClawIdUiError | null>(null);
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
          setError(openClawIdUiError(failure, "devices"));
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
          setError(openClawIdUiError(failure, "remove"));
        } finally {
          setBusy(false);
          await refresh();
        }
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
                  <OpenClawIdErrorMessage error={message()} />
                </div>
              )}
            </Show>
            <Show when={link() && !ownPub()}>
              <div class="callout info" role="note">
                {localOperator()
                  ? t("openclawId.approvalRequiresKey")
                  : t("openclawId.notOwnerDevice")}
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
                    approver={approverOf(devices(), device)}
                    approved={devicesApprovedBy(devices(), device)}
                    canRevoke={Boolean(ownPub())}
                    busy={busy()}
                    onRevoke={() => void revoke(device)}
                  />
                )}
              </For>
            </div>
            <Show when={localOperator() && ownPub()}>
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
                <div class="muted openclaw-id-devices__hint">
                  <p>{t("openclawId.recoveryKitLine")}</p>
                  <details>
                    <summary>{t("openclawId.securityDetails")}</summary>
                    {t("openclawId.kitOwnerFingerprint")}: {fp()}
                  </details>
                </div>
              )}
            </Show>
            <openclaw-modal-actions class="exec-approval-actions">
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
