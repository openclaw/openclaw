import { createMemo, For, Show } from "solid-js";
import { resolveCloudProfileIconData } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import type { PopoverHandle } from "../../components/solid/popover.tsx";
import { CloudProfileIcon } from "../../components/solid/provider-icon.tsx";
import { resolveMacFormFactorFromName } from "../../lib/mac-form-factor.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { SessionMenuItem, CloudProfileMenuItems } from "./cloud-target-view.tsx";
import type { DevicePlacementOption } from "./device-placement.ts";
import { SessionPicker } from "./picker.tsx";
import { environmentCapabilityLabels } from "./place-facts.ts";
import type { WhereChipOptions } from "./where-chip.ts";
function DevicePoolIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="2" y="7" width="14" height="11" />
      <path d="M6 7V3h16v12h-6M6 22h6M9 18v4" />
    </svg>
  );
}
function ConnectDeviceIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}
function MacDeviceIcon(props: { form: "laptop" | "mini" | "studio" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.form === "laptop" ? (
        <>
          <path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z" />
          <path d="M20.054 15.987H3.946" />
        </>
      ) : props.form === "mini" ? (
        <>
          <path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          <path d="M21.946 12.013H2.054M6 16h.01M10 16h.01" />
        </>
      ) : (
        <>
          <path d="m3 8 3-4h12l3 4v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M3 8h18M6 15h2M11 15h2M17 15h.01" />
        </>
      )}
    </svg>
  );
}
function EnvironmentDeviceIcon(props: { device?: DevicePlacementOption }) {
  const form = createMemo(() => {
    const platform = props.device?.platform?.trim();
    if (platform && !/^(?:darwin|macos|mac os(?: x)?)\b/i.test(platform)) {
      return undefined;
    }
    const value = resolveMacFormFactorFromName(props.device?.label);
    return value === "laptop" || value === "mini" || value === "studio" ? value : undefined;
  });
  return (
    <Show when={form()} fallback={<Icon name="monitor" />}>
      {(current) => (
        <span class="new-session-page__device-icon" data-form={current()}>
          <MacDeviceIcon form={current()} />
        </span>
      )}
    </Show>
  );
}

function renderEnvironmentSkeletons(section: "devices" | "cloud") {
  return (
    <div
      class="new-session-page__environment-skeletons"
      role="status"
      aria-label={t("common.loading")}
      aria-busy="true"
      data-section={section}
    >
      <span class="skeleton new-session-page__environment-skeleton-row" aria-hidden="true" />
      <span class="skeleton new-session-page__environment-skeleton-row" aria-hidden="true" />
    </div>
  );
}

function EnvironmentHeading(props: {
  label: string;
  action: "connect-machine" | "manage-cloud-workers";
  disabled: boolean;
  onAction: (() => void) | undefined;
}) {
  return (
    <div class="new-session-page__environment-heading new-session-page__devices-heading">
      <span>{props.label}</span>
      <Show when={props.onAction}>
        <button
          type="button"
          class="new-session-page__connect-device"
          data-action={props.action}
          aria-label={t(
            props.action === "connect-machine"
              ? "newSession.connectMachine"
              : "newSession.manageCloudWorkers",
          )}
          disabled={props.disabled}
          ref={nativeListener("click", () => props.onAction?.())}
        >
          <ConnectDeviceIcon />
        </button>
      </Show>
    </div>
  );
}

export function WhereChip(props: {
  params: WhereChipOptions;
  ref?: (handle: PopoverHandle) => void;
}) {
  const kind = createMemo(() => props.params.state.kind);
  const triggerIcon = createMemo(() =>
    kind() === "hosted" ? (
      <Icon name="cloud" />
    ) : kind() === "cloud" ? (
      <CloudProfileIcon
        profile={props.params.state.cloudProfiles.find(
          (profile) => profile.id === props.params.cloudProfileId,
        )}
      />
    ) : kind() === "local" ? (
      <Icon name="home" />
    ) : kind() === "auto-device" ? (
      <DevicePoolIcon />
    ) : (
      <EnvironmentDeviceIcon
        device={props.params.state.devices.find(
          (device) => device.deviceId === props.params.deviceId,
        )}
      />
    ),
  );
  const gatewayIcon = <Icon name="home" />;
  const view = createMemo(() => {
    const cloudPresentation = resolveCloudProfileIconData(
      props.params.state.cloudProfiles.find(
        (profile) => profile.id === props.params.cloudProfileId,
      ),
    );
    const localName = props.params.gatewayName.trim() || t("newSession.local");
    const label = props.params.state.kind === "local" ? localName : props.params.state.label;
    const configurationSummary =
      props.params.state.kind === "cloud"
        ? [
            props.params.state.operatingSystems.find(
              (os) => os.id === props.params.state.selectedOsId,
            )?.label,
            props.params.state.cloudMachines.find(
              (machine) => machine.id === props.params.state.selectedMachineId,
            )?.label,
          ]
            .filter(Boolean)
            .join(" · ")
        : "";
    const query = props.params.environmentQuery.trim().toLocaleLowerCase();
    const matches = (...values: (string | undefined)[]) =>
      values.some((value) => value?.toLocaleLowerCase().includes(query));
    const showLocal = matches(
      t("newSession.local"),
      t("newSession.gatewayHost"),
      props.params.gatewayName,
    );
    const devices = props.params.state.devices
      .filter((device) =>
        matches(
          t("newSession.device"),
          t("newSession.yourDevices"),
          device.label,
          device.deviceId,
          ...device.facts,
        ),
      )
      .toSorted((a, b) => Number(b.selectable) - Number(a.selectable));
    const hosted = (props.params.hostedEnvironments ?? []).filter((entry) =>
      matches(entry.label, entry.id, t("newSession.hosted")),
    );
    const showHostedSetup = matches("OpenAI Agents API", t("newSession.hosted"));
    const cloudProfiles = props.params.isAdmin
      ? props.params.state.cloudProfiles.filter((profile) =>
          matches(
            t("newSession.cloud"),
            profile.id,
            profile.providerId,
            profile.providerDisplayId,
            resolveCloudProfileIconData(profile).label,
            profile.trust === "disposable"
              ? t("newSession.environmentDisposable")
              : profile.trust === "persistent"
                ? t("newSession.environmentPersistent")
                : undefined,
          ),
        )
      : [];
    const suggestion = props.params.suggestedProfile;
    const showSuggestion =
      props.params.isAdmin &&
      props.params.state.cloudProfiles.length === 0 &&
      suggestion !== undefined &&
      matches(
        t("newSession.cloud"),
        suggestion.providerId,
        suggestion.providerDisplayId,
        resolveCloudProfileIconData(suggestion).label,
      );
    const showMissingCloud =
      props.params.isAdmin &&
      Boolean(props.params.cloudProfileId) &&
      !props.params.state.cloudProfiles.some(
        (profile) => profile.id === props.params.cloudProfileId,
      ) &&
      matches(t("newSession.cloud"), props.params.cloudProfileId);
    const showAuto =
      props.params.state.devices.length > 1 &&
      (devices.length > 0 || matches(t("newSession.autoDeviceChoose"), t("newSession.autoDevice")));
    const autoHelp =
      props.params.state.autoDeviceDisabledReason ??
      t(
        props.params.autoPlacementMode === "eligible-order"
          ? "newSession.autoDeviceHintEligible"
          : "newSession.autoDeviceHint",
      );
    const busy = props.params.submitting || props.params.pendingPlacement;
    const showDeviceSkeletons = props.params.catalogLoading && devices.length === 0;
    const showCloudSkeletons =
      props.params.isAdmin && props.params.catalogLoading && cloudProfiles.length === 0;
    return {
      cloudPresentation,
      localName,
      label,
      configurationSummary,
      showLocal,
      devices,
      hosted,
      showHostedSetup,
      cloudProfiles,
      showSuggestion,
      showMissingCloud,
      showAuto,
      autoHelp,
      busy,
      showDeviceSkeletons,
      showCloudSkeletons,
    };
  });
  return (
    <SessionPicker
      ref={(handle) => props.ref?.(handle)}
      kind="where"
      label={`${t("newSession.where")}: ${view().label}`}
      value={view().label}
      icon={triggerIcon()}
      summary={view().configurationSummary}
      triggerAttributes={{
        "aria-label": `${t("newSession.where")}: ${view().label}${view().configurationSummary ? `, ${view().configurationSummary}` : ""}`,
        "aria-description":
          props.params.state.kind === "cloud" && view().cloudPresentation.label
            ? t("newSession.cloudWorkerProvider", { provider: view().cloudPresentation.label })
            : undefined,
        "data-cloud-profile": props.params.cloudProfileId || undefined,
        "data-hosted-runtime": props.params.state.hostedRuntimeId || undefined,
        "data-machine-class": props.params.machineClass || undefined,
        "data-os": props.params.os || undefined,
        "data-device-id": props.params.deviceId || undefined,
        "data-auto-device": props.params.autoDevice ? "true" : undefined,
      }}
      state={props.params}
    >
      <div class="new-session-page__environment-layout">
        <div class="new-session-page__picker-root new-session-page__environment-picker">
          <label class="new-session-page__environment-search">
            <span aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              type="search"
              autofocus
              aria-label={t("newSession.environmentSearchPlaceholder")}
              placeholder={t("newSession.environmentSearchPlaceholder")}
              value={props.params.environmentQuery}
              disabled={view().busy}
              onInput={(event: Event) => {
                if (event.currentTarget instanceof HTMLInputElement) {
                  props.params.onEnvironmentQueryInput(event.currentTarget.value);
                }
              }}
            />
          </label>
          <div class="new-session-page__environment-list">
            <Show when={view().showLocal || view().devices.length || view().showAuto}>
              <EnvironmentHeading
                label={t("newSession.yourDevices")}
                action="connect-machine"
                disabled={view().busy}
                onAction={props.params.isAdmin ? props.params.onConnectMachine : undefined}
              />
            </Show>
            {view().showAuto ? (
              <openclaw-tooltip
                class="new-session-page__environment-details"
                placement="right-start"
              >
                <button
                  type="button"
                  class="session-menu__item new-session-page__environment-option"
                  data-value="auto-device"
                  data-popover="close"
                  aria-pressed={props.params.autoDevice === true ? "true" : "false"}
                  aria-description={view().autoHelp}
                  disabled={
                    view().busy ||
                    (!props.params.autoDevice &&
                      Boolean(props.params.state.autoDeviceDisabledReason))
                  }
                  ref={nativeListener("click", () => props.params.onSelectAutoDevice())}
                >
                  <span class="session-menu__icon" aria-hidden="true">
                    <DevicePoolIcon />
                  </span>
                  <span class="session-menu__text">{t("newSession.autoDeviceChoose")}</span>
                  <span class="session-menu__check" aria-hidden="true">
                    {props.params.autoDevice ? <Icon name="check" /> : undefined}
                  </span>
                </button>
                <div slot="content" class="new-session-page__environment-card">
                  <strong>{t("newSession.autoDeviceChoose")}</strong>
                  <div class="new-session-page__card-row">
                    <span class="new-session-page__card-icon" aria-hidden="true">
                      <Icon name="info" />
                    </span>
                    <span>{view().autoHelp}</span>
                  </div>
                </div>
              </openclaw-tooltip>
            ) : undefined}
            {view().showLocal ? (
              <SessionMenuItem
                item={{
                  value: "gateway",
                  label: view().localName,
                  icon: gatewayIcon,
                  summary: t("newSession.runsOnGateway"),
                  compact: true,
                  checked: props.params.state.kind === "local",
                  disabled: Boolean(props.params.hostDisabledReason),
                  title: props.params.hostDisabledReason,
                  onSelect: () => props.params.onSelectDevice(""),
                }}
                submitting={view().busy}
              />
            ) : undefined}
            <For each={view().devices} keyed={(device) => device.deviceId}>
              {(device) => {
                const icon = <EnvironmentDeviceIcon device={device()} />;
                const item = createMemo(() => {
                  const current = device();
                  return {
                    value: `device:${current.deviceId}`,
                    label: current.label,
                    sub: current.subtitle,
                    icon,
                    platform: current.platform ? prettifyPlatform(current.platform) : undefined,
                    capabilityLabels: environmentCapabilityLabels(current.capabilities),
                    hideDetails: current.hideDetails,
                    remediation: current.remediation,
                    capacityLabel:
                      current.selectable && current.workerSlots
                        ? t("newSession.concurrentSessionsValue", {
                            used: String(current.workerSlots.total - current.workerSlots.available),
                            total: String(current.workerSlots.total),
                          })
                        : undefined,
                    compact: true,
                    checked:
                      props.params.state.kind === "device" &&
                      props.params.deviceId === current.deviceId,
                    disabled: !current.selectable,
                    title: current.disabledReason,
                    onSelect: () => props.params.onSelectDevice(device().deviceId),
                  };
                });
                return <SessionMenuItem item={item()} submitting={view().busy} />;
              }}
            </For>
            {view().showDeviceSkeletons ? renderEnvironmentSkeletons("devices") : undefined}
            {view().hosted.length || view().showHostedSetup ? (
              <div class="new-session-page__environment-heading">
                <span>{t("newSession.hosted")}</span>
              </div>
            ) : undefined}
            {
              <For each={view().hosted} keyed={(entry) => entry.id}>
                {(entry) => (
                  <SessionMenuItem
                    item={{
                      value: `runtime:${entry().id}`,
                      label: entry().label,
                      icon: <Icon name="cloud" />,
                      compact: true,
                      summary: t("newSession.hostedHint"),
                      selectedSummary: entry().model,
                      checked: props.params.state.hostedRuntimeId === entry().id,
                      disabled: Boolean(entry().disabledReason),
                      title: entry().disabledReason,
                      onSelect: () => props.params.onSelectHostedEnvironment?.(entry().id),
                    }}
                    submitting={view().busy}
                  />
                )}
              </For>
            }
            {view().showHostedSetup && props.params.hostedLoading ? (
              <div role="status" class="new-session-page__environment-empty">
                {t("common.loading")}
              </div>
            ) : view().showHostedSetup &&
              !view().hosted.some((entry) => entry.id === "agentsapi") ? (
              <a
                class="session-menu__item new-session-page__environment-option"
                href="https://docs.openclaw.ai/plugins/agentsapi"
                target="_blank"
                rel="noreferrer"
                aria-description={t("newSession.hostedSetupHint")}
              >
                <span class="session-menu__icon">
                  <Icon name="info" />
                </span>
                <span class="session-menu__text">{t("newSession.hostedSetup")}</span>
              </a>
            ) : undefined}
            <Show
              when={
                view().cloudProfiles.length ||
                view().showSuggestion ||
                view().showMissingCloud ||
                view().showCloudSkeletons
              }
            >
              <EnvironmentHeading
                label={t("newSession.cloud")}
                action="manage-cloud-workers"
                disabled={view().busy}
                onAction={
                  props.params.isAdmin && !view().showCloudSkeletons && !view().showSuggestion
                    ? props.params.onManageCloudWorkers
                    : undefined
                }
              />
            </Show>
            {view().showSuggestion ? (
              <SessionMenuItem
                item={{
                  value: "suggested-cloud",
                  label: t("newSession.cloud"),
                  icon: <CloudProfileIcon profile={props.params.suggestedProfile} />,
                  compact: true,
                  checked: false,
                  disabled: Boolean(props.params.cloudDisabledReason),
                  title: props.params.cloudDisabledReason,
                  onSelect: () => props.params.onAdoptSuggestedProfile?.(),
                }}
                submitting={view().busy}
              />
            ) : undefined}
            <CloudProfileMenuItems
              params={{
                profiles: view().cloudProfiles,
                selectedId: props.params.cloudProfileId,
                selectedOs: props.params.state.selectedOsId,
                selectedMachine: props.params.state.selectedMachineId,
                onSelectOs: props.params.onSelectCloudOs,
                onSelectMachine: props.params.onSelectCloudMachine,
                submitting: view().busy,
                compact: true,
                disabled: Boolean(props.params.cloudDisabledReason),
                disabledReason: props.params.cloudDisabledReason,
                profileDisabledReason: props.params.cloudProfileDisabledReason,
                onSelect: props.params.onSelectCloudProfile,
              }}
            />
            {view().showCloudSkeletons ? renderEnvironmentSkeletons("cloud") : undefined}
            {view().showMissingCloud ? (
              <SessionMenuItem
                item={{
                  value: `cloud:${props.params.cloudProfileId}`,
                  label: props.params.cloudProfileId,
                  icon: <Icon name="cloud" />,
                  description: t("newSession.catalogUnavailable"),
                  compact: true,
                  checked: true,
                  disabled: true,
                  title: t("newSession.catalogUnavailable"),
                  onSelect: () => undefined,
                }}
                submitting={view().busy}
              />
            ) : undefined}
            {!view().showLocal &&
            view().devices.length === 0 &&
            view().cloudProfiles.length === 0 &&
            view().hosted.length === 0 &&
            !view().showHostedSetup &&
            !view().showMissingCloud &&
            !view().showSuggestion &&
            !view().showDeviceSkeletons &&
            !view().showCloudSkeletons ? (
              <div class="new-session-page__environment-empty" role="status">
                {t("newSession.environmentSearchEmpty")}
              </div>
            ) : undefined}
          </div>
        </div>
      </div>
    </SessionPicker>
  );
}
