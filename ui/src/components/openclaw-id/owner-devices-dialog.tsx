// "Your devices" from the account menu (OCF-280): the claw's active owner
// devices, who approved each one, which one is this browser, and Revoke for the
// others. Revoking also removes the devices the revoked one approved; the dialog
// names them first. Device keys are per claw, so a removal applies to this claw.
import "./owner-devices-dialog.css";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
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
import { IconButton } from "../solid/icon-button.tsx";
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
  confirming: boolean;
  onConfirm: (confirming: boolean) => void;
  onRevoke: () => void;
}) {
  return (
    <div
      role="listitem"
      data-device-pub={props.device.devicePub}
      class={[
        "row openclaw-id-devices__row",
        { "openclaw-id-devices__row--confirming": props.confirming },
      ]}
    >
      <div class="stack openclaw-id-devices__text">
        <strong class="openclaw-id-devices__label">
          <span class="openclaw-id-devices__name" title={props.device.label}>
            {props.device.label}
          </span>
          <Show when={props.isThisBrowser}>
            <span class="chip">{t("openclawId.thisBrowser")}</span>
          </Show>
        </strong>
        <div class="muted openclaw-id-devices__hint">
          {props.device.peerKeys.length > 0
            ? t("openclawId.deviceRemote")
            : t("openclawId.deviceLocal")}
          {" · "}
          {props.approver.kind === "kit"
            ? t("openclawId.approvedByKit")
            : props.approver.kind === "device"
              ? t("openclawId.approvedByDevice", { device: props.approver.label })
              : t("openclawId.approvedByRemoved")}
        </div>
      </div>
      <Show when={props.canRevoke && !props.isThisBrowser}>
        <Show
          when={props.confirming}
          fallback={
            <button
              type="button"
              class="btn btn--sm openclaw-id-devices__revoke"
              disabled={props.busy}
              onClick={() => props.onConfirm(true)}
            >
              {t("openclawId.revoke")}
            </button>
          }
        >
          <div class="openclaw-id-devices__confirmation">
            <p role="note">
              {props.approved.length > 0
                ? t("openclawId.revokeCascade", {
                    device: props.device.label,
                    devices: props.approved.map((device) => device.label).join(", "),
                  })
                : t("openclawId.revokeOne", { device: props.device.label })}
            </p>
            <openclaw-modal-actions>
              <button
                type="button"
                class="btn btn--sm"
                disabled={props.busy}
                onClick={() => props.onConfirm(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                class="btn btn--sm danger openclaw-id-devices__confirm-revoke"
                disabled={props.busy}
                onClick={() => props.onRevoke()}
              >
                {t("openclawId.revokeConfirm", { device: props.device.label })}
              </button>
            </openclaw-modal-actions>
          </div>
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
      const [confirming, setConfirming] = createSignal<string | null>(null);
      const [error, setError] = createSignal<OpenClawIdUiError | null>(null);
      let listElement: HTMLDivElement | undefined;
      let revocationPending = false;
      const refresh = async () => {
        try {
          const [next, status] = await Promise.all([
            readLink(params.client),
            params.client.request<OpenClawIdStatusResult>("openclawId.status", {}),
          ]);
          setLocalOperator(status.channel === "local_operator" && next.linked);
          setOwnPub((await thisOwnerDevice(next).catch(() => undefined))?.devicePub ?? null);
          setOwnerFp(await ownerFingerprint(next));
          // Only a fresh Gateway listing can start removal, including cascade removals.
          if (
            revocationPending &&
            !modal.settled &&
            !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ) {
            const remaining = new Set(next.ownerDevices?.map((device) => device.devicePub));
            await Promise.all(
              Array.from(listElement?.querySelectorAll<HTMLElement>("[data-device-pub]") ?? [])
                .filter((row) => !remaining.has(row.dataset.devicePub!))
                .map((row) =>
                  row
                    .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: "forwards" })
                    .finished.catch(() => {}),
                ),
            );
          }
          setLink(next);
          if (!next.ownerDevices?.some((device) => device.devicePub === confirming())) {
            setConfirming(null);
          }
        } catch (failure) {
          setError(openClawIdUiError(failure, "devices"));
        }
      };
      const revoke = async (device: OpenClawIdOwnerDevice) => {
        const current = link();
        if (!current || revocationPending) {
          return;
        }
        revocationPending = true;
        setBusy(true);
        setError(null);
        try {
          const statement = await signOwnerDeviceRevocation(current, device);
          await params.client.request("openclawId.authority", { action: "submit", statement });
        } catch (failure) {
          setError(openClawIdUiError(failure, "remove"));
        } finally {
          await refresh();
          revocationPending = false;
          setBusy(false);
        }
      };
      onSettled(() => {
        void refresh();
      });
      const devices = createMemo(() => {
        const current = ownPub();
        return (link()?.ownerDevices ?? []).toSorted(
          (a, b) => Number(b.devicePub === current) - Number(a.devicePub === current),
        );
      });
      return (
        <openclaw-modal-dialog
          class="openclaw-id-owner-dialog"
          label={t("openclawId.yourDevices")}
          description={t("openclawId.yourDevicesBody")}
          onModal-cancel={() => modal.finish(undefined)}
        >
          <div class="exec-approval-card openclaw-id-devices">
            <h2 class="exec-approval-title openclaw-id-devices__title">
              {t("openclawId.yourDevices")}
            </h2>
            <IconButton
              class="openclaw-id-devices__close"
              icon="x"
              label={t("common.close")}
              tooltip={false}
              onClick={() => modal.finish(undefined)}
            />
            <p class="openclaw-id-devices__description">{t("openclawId.yourDevicesBody")}</p>
            <Show when={error()}>
              {(message) => (
                <div class="openclaw-id-devices__error" role="alert">
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
              ref={(element) => {
                listElement = element;
              }}
              class="list openclaw-id-devices__list"
              role="list"
            >
              <For each={devices()} keyed={(device) => device.devicePub}>
                {(device) => (
                  <DeviceRow
                    device={device()}
                    isThisBrowser={device().devicePub === ownPub()}
                    approver={approverOf(devices(), device())}
                    approved={
                      confirming() === device().devicePub
                        ? devicesApprovedBy(devices(), device())
                        : []
                    }
                    canRevoke={Boolean(ownPub())}
                    busy={busy()}
                    confirming={confirming() === device().devicePub}
                    onConfirm={(value) => setConfirming(value ? device().devicePub : null)}
                    onRevoke={() => void revoke(device())}
                  />
                )}
              </For>
            </div>
            <div class="openclaw-id-devices__footer">
              <Show when={ownerFp()}>
                {(fp) => (
                  <div class="muted openclaw-id-devices__kit">
                    <p>{t("openclawId.recoveryKitLine")}</p>
                    <details>
                      <summary>{t("openclawId.securityDetails")}</summary>
                      <div>
                        {t("openclawId.kitOwnerFingerprint")}: {fp()}
                      </div>
                    </details>
                  </div>
                )}
              </Show>
              <Show when={localOperator() && ownPub()}>
                <openclaw-modal-actions>
                  <button
                    type="button"
                    class="btn primary"
                    onClick={() => {
                      modal.finish(undefined);
                      void showOwnerApprovalDialog({ client: params.client });
                    }}
                  >
                    {t("openclawId.approveNewDevice")}
                  </button>
                </openclaw-modal-actions>
              </Show>
            </div>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
