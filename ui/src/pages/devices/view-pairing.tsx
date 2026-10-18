import { createMemo, For, Show } from "solid-js";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import "../../components/modal-dialog.ts";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import type {
  DevicePairSetupAccess,
  DevicePairSetupLifecycle,
} from "../../lib/device-pair-setup.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatCountdown } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerDevicesEnglish);

const MOBILE_PAIRING_DOCS_URL =
  "https://docs.openclaw.ai/channels/pairing#pair-from-the-control-ui-recommended";
const NODE_PAIRING_DOCS_URL = "https://docs.openclaw.ai/gateway/pairing#one-paste-node-pairing";
const PAIRING_ACCESS_OPTIONS = [
  ["full", "devices.pairing.fullAccess", "devices.pairing.fullAccessHint"],
  ["limited", "devices.pairing.limitedAccess", "devices.pairing.limitedAccessHint"],
  ["node", "devices.pairing.nodeAccess", "devices.pairing.nodeAccessHint"],
] as const satisfies ReadonlyArray<readonly [DevicePairSetupAccess, string, string]>;

export type DevicePairSetupProps = {
  open: boolean;
  lifecycle: DevicePairSetupLifecycle;
  nowMs: number;
  pendingCount: number;
  onRefresh: () => void;
  onAccessChange: (access: DevicePairSetupAccess) => void;
  onClose: () => void;
  onManageDevices: () => void;
  onGetApps: () => void;
};

type PairingOutcomeLifecycle = Extract<
  DevicePairSetupLifecycle,
  { phase: "success" | "delivery-uncertain" | "expired" }
>;

function PairingOutcome(props: {
  lifecycle: PairingOutcomeLifecycle;
  description: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const success = () => props.lifecycle.phase === "success";
  const uncertain = () => props.lifecycle.phase === "delivery-uncertain";
  const deviceName = () =>
    props.lifecycle.phase === "success" ? props.lifecycle.deviceName : undefined;
  const action = () => (
    <button
      class="btn primary"
      type="button"
      onClick={() => (success() ? props.onClose() : props.onRefresh())}
    >
      <Show when={!success()}>
        <Icon name="refresh" />{" "}
      </Show>
      {t(success() ? "devices.pairing.done" : "devices.pairing.generateNewCode")}
    </button>
  );
  return (
    <div
      class="device-pair-setup__state"
      role={uncertain() ? "alert" : "status"}
      aria-live={uncertain() ? undefined : "polite"}
    >
      <div
        class={[
          "device-pair-setup__state-icon",
          { "device-pair-setup__state-icon--success": success() },
        ]}
        aria-hidden="true"
      >
        <Icon name={success() ? "badgeCheck" : uncertain() ? "alertTriangle" : "refresh"} />
      </div>
      <h3>{success() ? (deviceName() ?? props.description) : props.description}</h3>
      <Show
        when={success()}
        fallback={uncertain() ? <p>{t("devices.pairing.deliveryUncertainHint")}</p> : undefined}
      >
        <p>
          <Show when={deviceName()}>
            {props.description} <span aria-hidden="true">·</span>{" "}
          </Show>
          {t(
            props.lifecycle.access === "limited"
              ? "devices.pairing.limitedAccess"
              : props.lifecycle.access === "node"
                ? "devices.pairing.nodeAccessSummary"
                : "devices.pairing.fullAccessSummary",
          )}
        </p>
      </Show>
      <Show when={uncertain()} fallback={action()}>
        <div class="device-pair-setup__actions">{action()}</div>
      </Show>
    </div>
  );
}

export function DevicePairSetup(props: DevicePairSetupProps) {
  const setup = createMemo(() =>
    props.lifecycle.phase === "waiting" ? props.lifecycle.setup : undefined,
  );
  const outcome = createMemo(() => {
    const lifecycle = props.lifecycle;
    return lifecycle.phase === "success" ||
      lifecycle.phase === "delivery-uncertain" ||
      lifecycle.phase === "expired"
      ? lifecycle
      : undefined;
  });
  const error = createMemo(() => (props.lifecycle.phase === "error" ? props.lifecycle : undefined));
  // Terminal states reuse their headline so the dialog description follows the visible state.
  const description = () =>
    t(
      props.lifecycle.phase === "success"
        ? "devices.pairing.pairedTitle"
        : props.lifecycle.phase === "delivery-uncertain"
          ? "devices.pairing.deliveryUncertainTitle"
          : props.lifecycle.phase === "expired"
            ? "devices.pairing.expiredTitle"
            : "devices.pairing.subtitle",
    );
  const isNodeSetup = () => props.lifecycle.access === "node";
  const showAccessChoices = () =>
    props.lifecycle.phase !== "success" &&
    props.lifecycle.phase !== "delivery-uncertain" &&
    props.lifecycle.phase !== "reconciling" &&
    error()?.source !== "status";
  const canSelectAccess = () =>
    props.lifecycle.phase === "selection" || error()?.source === "create";
  const copyLabel = () => t("devices.pairing.copySetupCode");
  return (
    <Show when={props.open}>
      <openclaw-modal-dialog
        label={t("devices.pairing.title")}
        description={description()}
        onModal-cancel={() => props.onClose()}
      >
        <section class="device-pair-setup">
          <header class="device-pair-setup__header">
            <div class="device-pair-setup__phone" aria-hidden="true">
              <Icon name={isNodeSetup() ? "server" : "smartphone"} />
            </div>
            <div>
              <h2>{t("devices.pairing.title")}</h2>
              <p>{description()}</p>
              <Show when={props.lifecycle.phase !== "success" && !isNodeSetup()}>
                <p class="device-pair-setup__get-apps">
                  {t("devices.pairing.noApp")}{" "}
                  <button type="button" onClick={() => props.onGetApps()}>
                    {t("devices.pairing.getApps")}
                  </button>
                </p>
              </Show>
            </div>
            <button
              class="btn btn--icon btn--ghost device-pair-setup__close"
              type="button"
              aria-label={t("common.dismiss")}
              onClick={() => props.onClose()}
            >
              <Icon name="x" />
            </button>
          </header>
          <div class="device-pair-setup__body">
            <Show when={showAccessChoices()}>
              <fieldset class="device-pair-setup__access" disabled={!canSelectAccess()}>
                <legend>{t("devices.pairing.accessTitle")}</legend>
                <For each={PAIRING_ACCESS_OPTIONS}>
                  {(option) => (
                    <label>
                      <input
                        type="radio"
                        name="device-pair-access"
                        checked={props.lifecycle.access === option[0]}
                        onChange={() => props.onAccessChange(option[0])}
                      />
                      <span>
                        <strong>{t(option[1])}</strong>
                        <small>{t(option[2])}</small>
                      </span>
                    </label>
                  )}
                </For>
              </fieldset>
            </Show>
            <Show when={props.lifecycle.phase === "selection"}>
              <button class="btn primary" type="button" onClick={() => props.onRefresh()}>
                <Icon name={isNodeSetup() ? "server" : "smartphone"} />
                {t("devices.pairing.generateCode")}
              </button>
            </Show>
            <Show
              when={props.lifecycle.phase === "loading" || props.lifecycle.phase === "reconciling"}
            >
              <div class="device-pair-setup__loading" role="status" aria-live="polite">
                <span class="device-pair-setup__spinner" aria-hidden="true" />
                <span>
                  {t(
                    props.lifecycle.phase === "loading"
                      ? "devices.pairing.generating"
                      : "common.loading",
                  )}
                </span>
              </div>
            </Show>
            <Show when={error()}>
              {(failure) => (
                <>
                  <div class="callout danger device-pair-setup__error" role="alert">
                    <strong>
                      {t(
                        failure().source === "status"
                          ? "devices.pairing.statusFailed"
                          : "devices.pairing.failed",
                      )}
                    </strong>
                    <span>{failure().message}</span>
                  </div>
                  <button class="btn primary" type="button" onClick={() => props.onRefresh()}>
                    <Icon name="refresh" /> {t("common.reload")}
                  </button>
                </>
              )}
            </Show>
            <Show when={setup()}>
              {(current) => {
                const expired = () => current().expiresAtMs <= props.nowMs;
                const command = () => `openclaw node run --pair "oc-pair://${current().setupCode}"`;
                return (
                  <>
                    <Show
                      when={isNodeSetup()}
                      fallback={
                        <div class="device-pair-setup__qr-frame">
                          <Show
                            when={current().qrDataUrl}
                            fallback={
                              <div class="device-pair-setup__qr-unavailable">
                                {t("devices.pairing.qrUnavailable")}
                              </div>
                            }
                          >
                            {(url) => (
                              <img
                                class="device-pair-setup__qr"
                                src={url()}
                                alt={t("devices.pairing.qrAlt")}
                                width="360"
                                height="360"
                                draggable="false"
                              />
                            )}
                          </Show>
                        </div>
                      }
                    >
                      <div class="device-pair-setup__command">
                        <Show when={!expired()}>
                          <div class="login-gate__command">
                            <code>{command()}</code>
                            <CopyButton
                              text={command()}
                              idleLabel={t("connection.help.copyCommand")}
                            />
                          </div>
                        </Show>
                        <p class="device-pair-setup__waiting" role="timer" aria-live="off">
                          {expired()
                            ? t("devices.pairing.nodeExpired")
                            : t("devices.pairing.nodeExpiresIn", {
                                time: formatCountdown(current().expiresAtMs, props.nowMs),
                              })}
                        </p>
                      </div>
                    </Show>
                    <div class="device-pair-setup__meta">
                      <span class="settings-status settings-status--accent">
                        <span class="settings-status__dot" />
                        {current().auth}
                      </span>
                      <div class="device-pair-setup__gateways">
                        <For each={current().gatewayUrls ?? [current().gatewayUrl]}>
                          {(url) => (
                            <span class="device-pair-setup__gateway" title={url}>
                              {url}
                            </span>
                          )}
                        </For>
                      </div>
                    </div>
                    <Show when={current().accessDowngraded}>
                      <div class="callout warn device-pair-setup__access-warning" role="status">
                        <strong>{t("devices.pairing.transportLimitedTitle")}</strong>
                        <span>{t("devices.pairing.transportLimitedHint")}</span>
                      </div>
                    </Show>
                    <div class="device-pair-setup__actions">
                      <Show when={!isNodeSetup()}>
                        <For each={[current().setupCode]}>
                          {(code) => (
                            <button
                              class="btn primary"
                              type="button"
                              onClick={(event) => void handleCopyButton(event, code, copyLabel())}
                            >
                              <Icon name="copy" /> <span data-copy-label>{copyLabel()}</span>
                            </button>
                          )}
                        </For>
                      </Show>
                      <button class="btn" type="button" onClick={() => props.onRefresh()}>
                        <Icon name="refresh" /> {t("devices.pairing.newCode")}
                      </button>
                    </div>
                    <details class="device-pair-setup__fallback">
                      <summary>{t("devices.pairing.showSetupCode")}</summary>
                      <code>{current().setupCode}</code>
                    </details>
                    <Show
                      when={props.pendingCount > 0}
                      fallback={
                        <p class="device-pair-setup__waiting">
                          {t(
                            isNodeSetup()
                              ? "devices.pairing.nodeWaiting"
                              : "devices.pairing.waiting",
                          )}
                        </p>
                      }
                    >
                      <div class="callout warn device-pair-setup__pending">
                        <span>
                          {t("devices.pairing.pending", { count: String(props.pendingCount) })}
                        </span>
                        <button class="btn btn--sm" onClick={() => props.onManageDevices()}>
                          {t("devices.pairing.review")}
                        </button>
                      </div>
                    </Show>
                  </>
                );
              }}
            </Show>
            <Show when={outcome()}>
              {(result) => (
                <For each={[result().phase]}>
                  {() => (
                    <PairingOutcome
                      lifecycle={result()}
                      description={description()}
                      onClose={() => props.onClose()}
                      onRefresh={() => props.onRefresh()}
                    />
                  )}
                </For>
              )}
            </Show>
          </div>
          <footer class="device-pair-setup__footer">
            <a
              href={isNodeSetup() ? NODE_PAIRING_DOCS_URL : MOBILE_PAIRING_DOCS_URL}
              target={EXTERNAL_LINK_TARGET}
              rel={buildExternalLinkRel()}
              aria-label={t("devices.pairing.helpNewTab")}
            >
              <span>{t("devices.pairing.help")}</span>
              <span class="device-pair-setup__external-icon" aria-hidden="true">
                <Icon name="externalLink" />
              </span>
            </a>
            <button class="btn btn--ghost" type="button" onClick={() => props.onManageDevices()}>
              {t("devices.pairing.manageDevices")}
            </button>
          </footer>
        </section>
      </openclaw-modal-dialog>
    </Show>
  );
}
