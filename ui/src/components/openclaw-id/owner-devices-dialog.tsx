// "Your devices" from the account menu (OCF-280): the claw's active owner
// devices, who approved each one, which one is this browser, and Revoke for the
// others. Revoking also removes the devices the revoked one approved; the dialog
// names them first. Device keys are per claw, so a removal applies to this claw.
import "./owner-devices-dialog.css";
import { createMemo, createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
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
import { getLocale, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { IconButton } from "../solid/icon-button.tsx";
import { Icon } from "../solid/icon.tsx";
import { OpenClawIdErrorMessage } from "./error-message.tsx";
import { showOwnerApprovalDialog } from "./owner-approval-dialog.tsx";
import { createOwnerDialogMotion } from "./owner-dialog-motion.ts";

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
  morph: (element: HTMLElement) => void;
  registerElement: (element: HTMLDivElement) => () => void;
  onConfirm: (confirming: boolean) => void;
  onRevoke: () => void;
}) {
  let rowElement: HTMLDivElement | undefined;
  onSettled(() => props.registerElement(rowElement!));
  const explanation = createMemo(() => {
    const message =
      props.approved.length > 0
        ? t("openclawId.revokeCascade", {
            device: props.device.label,
            devices: props.approved.map((device) => device.label).join(", "),
          })
        : t("openclawId.revokeOne", { device: props.device.label });
    // Separate the final recovery sentence without rewriting localized copy or device names.
    const sentences = [
      ...new Intl.Segmenter(getLocale(), { granularity: "sentence" }).segment(message),
    ];
    const recoveryStart = sentences.at(-1)?.index ?? 0;
    return recoveryStart
      ? [message.slice(0, recoveryStart), message.slice(recoveryStart)]
      : [message];
  });
  return (
    <div
      ref={(element) => {
        rowElement = element;
        props.morph(element);
      }}
      role="listitem"
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
      <Show when={props.isThisBrowser}>
        <span class="chip">{t("openclawId.thisBrowser")}</span>
      </Show>
      <Show when={props.canRevoke && !props.isThisBrowser}>
        <Show
          when={props.confirming}
          fallback={
            <button
              type="button"
              class="openclaw-id-devices__revoke"
              disabled={props.busy}
              onClick={() => props.onConfirm(true)}
            >
              {t("openclawId.revoke")}
            </button>
          }
        >
          <div class="openclaw-id-devices__confirmation openclaw-id-owner-enter">
            <div role="note">
              <For each={explanation()}>{(sentence) => <p>{sentence}</p>}</For>
            </div>
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
      const [securityOpen, setSecurityOpen] = createSignal(false);
      const securityId = createUniqueId();
      const [error, setError] = createSignal<OpenClawIdUiError | null>(null);
      const motion = createOwnerDialogMotion();
      const rowElements = new Map<string, HTMLDivElement>();
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
          if (revocationPending && !modal.settled) {
            const remaining = new Set(next.ownerDevices?.map((device) => device.devicePub));
            await motion.collapse(
              [...rowElements].filter(([key]) => !remaining.has(key)).map(([, row]) => row),
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
          class="openclaw-id-owner-dialog openclaw-id-owner-dialog--devices"
          label={t("openclawId.yourDevices")}
          description={t("openclawId.yourDevicesBody")}
          onModal-cancel={() => modal.finish(undefined)}
        >
          <div ref={motion.card} class="exec-approval-card openclaw-id-devices">
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
                <div class="openclaw-id-devices__error openclaw-id-owner-enter" role="alert">
                  <OpenClawIdErrorMessage error={message()} />
                </div>
              )}
            </Show>
            <div
              class={[
                "list openclaw-id-devices__list",
                { "openclaw-id-owner-enter": devices().length > 0 },
              ]}
              role="list"
              tabindex={0}
              aria-label={t("openclawId.yourDevices")}
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
                    morph={motion.section}
                    registerElement={(element) => {
                      // The keyed row owns this registration until it unmounts.
                      const initialDevicePub = device().devicePub;
                      rowElements.set(initialDevicePub, element);
                      return () => {
                        rowElements.delete(initialDevicePub);
                      };
                    }}
                    onConfirm={(value) => setConfirming(value ? device().devicePub : null)}
                    onRevoke={() => void revoke(device())}
                  />
                )}
              </For>
            </div>
            <div
              ref={motion.section}
              id={securityId}
              class={["openclaw-id-devices__kit", { "openclaw-id-owner-enter": securityOpen() }]}
              hidden={!securityOpen()}
            >
              <Show when={ownerFp()}>
                {(fp) => (
                  <>
                    <dl>
                      <dt>{t("openclawId.kitOwnerFingerprint")}</dt>
                      <dd>{fp()}</dd>
                    </dl>
                    <p>{t("openclawId.recoveryKitLine")}</p>
                  </>
                )}
              </Show>
            </div>
            <div class="openclaw-id-devices__footer openclaw-id-owner-enter">
              <Show when={ownerFp()}>
                <button
                  type="button"
                  class="openclaw-id-devices__security"
                  aria-expanded={securityOpen() ? "true" : "false"}
                  aria-controls={securityId}
                  onClick={() => setSecurityOpen((open) => !open)}
                >
                  {t("openclawId.securityDetails")}
                  <Icon name="chevronDown" />
                </button>
              </Show>
              <Show when={localOperator() && ownPub()}>
                <openclaw-modal-actions>
                  <button
                    type="button"
                    class="btn primary"
                    onClick={() => {
                      modal.finish(undefined);
                      void showOwnerApprovalDialog({
                        client: params.client,
                        onDevices: () => void showOwnerDevicesDialog(params),
                      });
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
