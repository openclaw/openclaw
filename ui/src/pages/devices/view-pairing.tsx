import "../../styles/device-pair-setup.css";
import { action, createOptimistic, For, Show, until } from "solid-js";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import "../../components/modal-dialog.tsx";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { Radio } from "../../components/solid/radio.tsx";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import type {
  DevicePairSetupAccess,
  DevicePairSetupLifecycle,
} from "../../lib/device-pair-setup.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatCountdown } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";

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
  onRefresh: () => Promise<void>;
  onAccessChange: (access: DevicePairSetupAccess) => void;
  onClose: () => void;
  onManageDevices: () => void;
  onGetApps: () => void;
};

type PairingOutcomeLifecycle = Extract<
  DevicePairSetupLifecycle,
  { phase: "success" | "delivery-uncertain" | "expired" }
>;

function accessSummaryKey(access: DevicePairSetupAccess) {
  return access === "limited"
    ? "devices.pairing.limitedAccess"
    : access === "node"
      ? "devices.pairing.nodeAccessSummary"
      : "devices.pairing.fullAccessSummary";
}

function PairingOutcome(props: { lifecycle: PairingOutcomeLifecycle; description: string }) {
  const success = () => props.lifecycle.phase === "success";
  const uncertain = () => props.lifecycle.phase === "delivery-uncertain";
  const deviceName = () =>
    props.lifecycle.phase === "success" ? props.lifecycle.deviceName : undefined;
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
          {t(accessSummaryKey(props.lifecycle.access))}
        </p>
      </Show>
    </div>
  );
}

export function DevicePairSetup(props: DevicePairSetupProps) {
  const [refreshing, setRefreshing] = createOptimistic(false);
  const presentRefresh = action(function* (
    operation: Promise<void>,
    lifecycle: DevicePairSetupLifecycle,
  ) {
    const retired = new AbortController();
    try {
      setRefreshing(true);
      // Read staged owner changes so closing the dialog never waits for the RPC.
      yield Promise.race([
        operation,
        until(() => !props.open || props.lifecycle !== lifecycle, { signal: retired.signal }),
      ]);
    } finally {
      retired.abort();
    }
  });
  async function refresh() {
    let lifecycle = props.lifecycle;
    try {
      const operation = props.onRefresh();
      // Commit the owner's admission before the optimistic presentation joins it.
      await Promise.resolve();
      lifecycle = props.lifecycle;
      await presentRefresh(operation, lifecycle);
    } catch (error) {
      if (props.open && props.lifecycle === lifecycle) {
        showToast({
          message: t("devices.pairing.failed"),
          detail: formatUiError(error),
          severity: "error",
        });
      }
    }
  }
  const setup = () => (props.lifecycle.phase === "waiting" ? props.lifecycle.setup : undefined);
  const outcome = () => {
    const lifecycle = props.lifecycle;
    return lifecycle.phase === "success" ||
      lifecycle.phase === "delivery-uncertain" ||
      lifecycle.phase === "expired"
      ? lifecycle
      : undefined;
  };
  const error = () => (props.lifecycle.phase === "error" ? props.lifecycle : undefined);
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
  // A code is minted for one access level, so the choice only shows while it can still change.
  const showAccessChoices = () =>
    props.lifecycle.phase === "selection" || error()?.source === "create";
  const canSelectAccess = () =>
    !refreshing() && (props.lifecycle.phase === "selection" || error()?.source === "create");
  const copyLabel = () => t("devices.pairing.copySetupCode");
  return (
    <Show when={props.open}>
      <openclaw-modal-dialog
        label={t("devices.pairing.title")}
        description={description()}
        onModal-cancel={() => props.onClose()}
      >
        <section class="oc-dialog device-pair-setup">
          <header class="oc-dialog__header">
            <h2 class="oc-dialog__title">{t("devices.pairing.title")}</h2>
            <div class="oc-dialog__header-actions">
              {/* Help is wanted at any step, so it sits beside close instead of under the title. */}
              <openclaw-tooltip prop:content={t("devices.pairing.help")}>
                <a
                  class="oc-icon-button oc-icon-button--28 oc-dialog__icon-button device-pair-setup__help"
                  href={isNodeSetup() ? NODE_PAIRING_DOCS_URL : MOBILE_PAIRING_DOCS_URL}
                  target={EXTERNAL_LINK_TARGET}
                  rel={buildExternalLinkRel()}
                  aria-label={t("devices.pairing.helpNewTab")}
                >
                  <Icon name="circleQuestionMark" />
                </a>
              </openclaw-tooltip>
              <IconButton
                size={28}
                class="oc-dialog__close device-pair-setup__close"
                icon="x"
                label={t("common.dismiss")}
                tooltip={false}
                onClick={() => props.onClose()}
              />
            </div>
            {/* A finished state says its result once, in the body. */}
            <Show when={!outcome()}>
              <div class="oc-dialog__description">
                <p>{description()}</p>
              </div>
            </Show>
          </header>
          <div class="oc-dialog__body device-pair-setup__body">
            <Show when={showAccessChoices()}>
              <fieldset class="device-pair-setup__access" disabled={!canSelectAccess()}>
                <legend>{t("devices.pairing.accessTitle")}</legend>
                <For each={PAIRING_ACCESS_OPTIONS}>
                  {(option) => (
                    <Radio
                      name="device-pair-access"
                      checked={props.lifecycle.access === option[0]}
                      onChange={() => props.onAccessChange(option[0])}
                    >
                      <span>
                        <strong>{t(option[1])}</strong>
                        <small>{t(option[2])}</small>
                      </span>
                    </Radio>
                  )}
                </For>
              </fieldset>
            </Show>
            <Show
              when={
                refreshing() ||
                props.lifecycle.phase === "loading" ||
                props.lifecycle.phase === "reconciling"
              }
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
                <InlineAlert tone="danger" class="device-pair-setup__error" role="alert">
                  <strong>
                    {t(
                      failure().source === "status"
                        ? "devices.pairing.statusFailed"
                        : "devices.pairing.failed",
                    )}
                  </strong>
                  <span>{failure().message}</span>
                </InlineAlert>
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
                    <Show when={props.pendingCount === 0}>
                      <p class="device-pair-setup__waiting">
                        <Show when={!isNodeSetup()} fallback={t("devices.pairing.nodeWaiting")}>
                          {/* The app is needed to scan, so getting it sits with the scan step. */}
                          {t("devices.pairing.waiting")}{" "}
                          <button
                            class="device-pair-setup__link"
                            type="button"
                            onClick={() => props.onGetApps()}
                          >
                            {t("devices.pairing.getApps")}
                          </button>
                        </Show>
                      </p>
                    </Show>
                    <div class="device-pair-setup__meta">
                      <span>{`${t(accessSummaryKey(props.lifecycle.access))} · ${current().auth}`}</span>
                      <For each={current().gatewayUrls ?? [current().gatewayUrl]}>
                        {(url) => (
                          <span class="device-pair-setup__gateway" title={url}>
                            {url}
                          </span>
                        )}
                      </For>
                    </div>
                    <Show when={current().accessDowngraded}>
                      <InlineAlert
                        tone="warning"
                        class="device-pair-setup__access-warning"
                        role="status"
                      >
                        <strong>{t("devices.pairing.transportLimitedTitle")}</strong>
                        <span>{t("devices.pairing.transportLimitedHint")}</span>
                      </InlineAlert>
                    </Show>
                    {/* Stays mounted while empty so the first request updates an existing live region. */}
                    <div
                      class={
                        props.pendingCount > 0
                          ? "callout warn device-pair-setup__pending"
                          : "sr-only"
                      }
                      role="status"
                    >
                      <Show when={props.pendingCount > 0}>
                        <span>
                          {t("devices.pairing.pending", { count: String(props.pendingCount) })}
                        </span>
                      </Show>
                    </div>
                    <div class="device-pair-setup__code">
                      <details class="device-pair-setup__fallback">
                        <summary>
                          <Icon name="chevronRight" />
                          {t("devices.pairing.showSetupCode")}
                        </summary>
                        <code>{current().setupCode}</code>
                      </details>
                      <button
                        class="btn btn--sm btn--ghost"
                        type="button"
                        disabled={refreshing()}
                        onClick={() => void refresh()}
                      >
                        <Icon name="refresh" /> {t("devices.pairing.newCode")}
                      </button>
                    </div>
                  </>
                );
              }}
            </Show>
            <Show when={outcome()}>
              {(result) => (
                <For each={[result().phase]}>
                  {() => <PairingOutcome lifecycle={result()} description={description()} />}
                </For>
              )}
            </Show>
          </div>
          <openclaw-modal-actions class="oc-dialog__footer device-pair-setup__footer device-pair-setup__actions">
            {/* Review opens the same page, and says why, once a request is waiting. */}
            <Show when={!setup() || props.pendingCount === 0}>
              <button class="btn btn--ghost" type="button" onClick={() => props.onManageDevices()}>
                {t("devices.pairing.manageDevices")}
              </button>
            </Show>
            <Show when={props.lifecycle.phase === "selection"}>
              <button
                class="btn primary"
                type="button"
                disabled={refreshing()}
                onClick={() => void refresh()}
              >
                {t("devices.pairing.generateCode")}
              </button>
            </Show>
            <Show when={error()}>
              <button
                class="btn primary"
                type="button"
                disabled={refreshing()}
                onClick={() => void refresh()}
              >
                <Icon name="refresh" /> {t("common.reload")}
              </button>
            </Show>
            <Show when={setup()}>
              {(current) => (
                <>
                  <Show when={!isNodeSetup()}>
                    <For each={[current().setupCode]}>
                      {(code) => {
                        let label!: HTMLSpanElement;
                        return (
                          <button
                            class={["btn", { primary: props.pendingCount === 0 }]}
                            type="button"
                            onClick={(event) => {
                              void handleCopyButton(event, code, copyLabel(), { label }).then(
                                (copied) => {
                                  if (!copied && props.open) {
                                    showToast({
                                      severity: "error",
                                      message: t("devices.pairing.copyFailed"),
                                    });
                                  }
                                },
                              );
                            }}
                          >
                            <Icon name="copy" />{" "}
                            <span ref={(element) => (label = element)} data-copy-label>
                              {copyLabel()}
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                  <Show when={props.pendingCount > 0}>
                    <button
                      class="btn primary"
                      type="button"
                      onClick={() => props.onManageDevices()}
                    >
                      {t("devices.pairing.review")}
                    </button>
                  </Show>
                </>
              )}
            </Show>
            <Show when={outcome()}>
              {(result) => (
                <For each={[result().phase]}>
                  {(phase) => (
                    <button
                      class="btn primary"
                      type="button"
                      disabled={phase !== "success" && refreshing()}
                      onClick={() => (phase === "success" ? props.onClose() : void refresh())}
                    >
                      <Show when={phase !== "success"}>
                        <Icon name="refresh" />{" "}
                      </Show>
                      {t(
                        phase === "success"
                          ? "devices.pairing.done"
                          : "devices.pairing.generateNewCode",
                      )}
                    </button>
                  )}
                </For>
              )}
            </Show>
          </openclaw-modal-actions>
        </section>
      </openclaw-modal-dialog>
    </Show>
  );
}
