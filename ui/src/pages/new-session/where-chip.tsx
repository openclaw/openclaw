import { action, createMemo, createOptimistic, For, Loading, Show } from "solid-js";
import { resolveCloudProfileIconData } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import type { PopoverHandle } from "../../components/solid/popover.tsx";
import { CloudProfileIcon } from "../../components/solid/provider-icon.tsx";
import { StrokeIcon } from "../../components/solid/stroke-icon.tsx";
import { resolveMacFormFactorFromName } from "../../lib/mac-form-factor.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { SessionMenuItem, CloudProfileMenuItems } from "./cloud-target-view.tsx";
import type { DevicePlacementOption } from "./device-placement.ts";
import type { SuggestedProfileAdoption } from "./draft-suggested-cloud-profile.ts";
import {
  environmentPlacementRuntime,
  environmentCloudDisabledReason,
} from "./hosted-environments.ts";
import { SessionPicker } from "./picker.tsx";
import { environmentCapabilityLabels } from "./place-facts.ts";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";
import type { resolveWhereChip } from "./where-chip.ts";
function DevicePoolIcon() {
  return (
    <StrokeIcon>
      <rect x="2" y="7" width="14" height="11" />
      <path d="M6 7V3h16v12h-6M6 22h6M9 18v4" />
    </StrokeIcon>
  );
}
function ConnectDeviceIcon() {
  return (
    <StrokeIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </StrokeIcon>
  );
}
function MacDeviceIcon(props: { form: "laptop" | "mini" | "studio" }) {
  return (
    <StrokeIcon>
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
    </StrokeIcon>
  );
}
function EnvironmentDeviceIcon(props: { device?: DevicePlacementOption }) {
  const form = () => {
    const platform = props.device?.platform?.trim();
    if (platform && !/^(?:darwin|macos|mac os(?: x)?)\b/i.test(platform)) {
      return undefined;
    }
    const value = resolveMacFormFactorFromName(props.device?.label);
    return value === "laptop" || value === "mini" || value === "studio" ? value : undefined;
  };
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
  params: NewSessionPlaceControlsOptions;
  state: ReturnType<typeof resolveWhereChip>;
  ref?: (handle: PopoverHandle) => void;
}) {
  const [saving, setSaving] = createOptimistic(false);
  const presentAdoption = action(function* (request: SuggestedProfileAdoption) {
    if (request.isCurrent()) {
      setSaving(true);
    }
    yield Promise.race([request.completion, request.retired]);
  });
  const adoptSuggestedProfile = () => {
    void props.params.place.suggestedCloudProfile.adopt((request) => {
      // Publish the owner's admitted operation before its presentation joins the tick.
      void Promise.resolve()
        .then(() => presentAdoption(request))
        .catch(request.reportError);
    });
  };
  const selectCloudOption = (kind: "os" | "machine", id: string) =>
    props.params.place.cloudMachines[kind === "os" ? "selectOs" : "select"](
      props.params.place.cloudProfileId,
      id,
      props.state.cloudProfiles,
      props.params.submitting || props.params.pendingPlacement,
      props.params.onChange,
    );
  const kind = createMemo(() => props.state.kind);
  const triggerIcon = createMemo(() =>
    kind() === "hosted" ? (
      <Icon name="cloud" />
    ) : kind() === "cloud" ? (
      <CloudProfileIcon
        profile={props.state.cloudProfiles.find(
          (profile) => profile.id === props.params.place.cloudProfileId,
        )}
      />
    ) : kind() === "local" ? (
      <Icon name="home" />
    ) : kind() === "auto-device" ? (
      <DevicePoolIcon />
    ) : (
      <EnvironmentDeviceIcon
        device={props.state.devices.find(
          (device) => device.deviceId === props.params.place.deviceId,
        )}
      />
    ),
  );
  const gatewayIcon = <Icon name="home" />;
  const cloudProfilesCompletion = createMemo(
    () => ({ promise: props.params.gateway.cloudProfilesRead }),
    { equals: (previous, next) => previous.promise === next.promise },
  );
  // The owner keeps retry failures quiet and retains its accepted catalog.
  const cloudProfilesRead = createMemo(() => cloudProfilesCompletion().promise?.then(() => null));
  const view = createMemo(() => {
    const cloudSelection = props.params.place.cloudSelection;
    const cloudPresentation = resolveCloudProfileIconData(
      props.state.cloudProfiles.find((profile) => profile.id === props.params.place.cloudProfileId),
    );
    const localName = props.params.gateway.gatewayName.trim() || t("newSession.local");
    const label = props.state.kind === "local" ? localName : props.state.label;
    const configurationSummary =
      props.state.kind === "cloud"
        ? [
            props.state.operatingSystems.find((os) => os.id === props.state.selectedOsId)?.label,
            props.state.cloudMachines.find(
              (machine) => machine.id === props.state.selectedMachineId,
            )?.label,
          ]
            .filter(Boolean)
            .join(" · ")
        : "";
    const query = props.params.place.browser.environmentQuery.trim().toLocaleLowerCase();
    const matches = (...values: (string | undefined)[]) =>
      values.some((value) => value?.toLocaleLowerCase().includes(query));
    const showLocal = matches(
      t("newSession.local"),
      t("newSession.gatewayHost"),
      props.params.gateway.gatewayName,
    );
    const devices = props.state.devices
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
    const hosted = props.params.place.modelControl
      .hostedEnvironments()
      .filter((entry) => matches(entry.label, entry.id, t("newSession.hosted")));
    const showHostedSetup = matches("OpenAI Agents API", t("newSession.hosted"));
    const cloudProfiles = props.params.place.isAdmin()
      ? props.state.cloudProfiles.filter((profile) =>
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
    const suggestion = props.params.gateway.suggestedProfile;
    const showSuggestion =
      props.params.place.isAdmin() &&
      props.state.cloudProfiles.length === 0 &&
      suggestion !== undefined &&
      matches(
        t("newSession.cloud"),
        suggestion.providerId,
        suggestion.providerDisplayId,
        resolveCloudProfileIconData(suggestion).label,
      );
    const showMissingCloud =
      props.params.place.isAdmin() &&
      Boolean(props.params.place.cloudProfileId) &&
      !props.state.cloudProfiles.some(
        (profile) => profile.id === props.params.place.cloudProfileId,
      ) &&
      matches(t("newSession.cloud"), props.params.place.cloudProfileId);
    const showAuto =
      props.state.devices.length > 1 &&
      (devices.length > 0 || matches(t("newSession.autoDeviceChoose"), t("newSession.autoDevice")));
    const autoHelp =
      props.state.autoDeviceDisabledReason ??
      t(
        props.params.place.modelControl.autoPlacementSelectionMode(
          environmentPlacementRuntime(props.params.place.modelControl),
        ) === "eligible-order"
          ? "newSession.autoDeviceHintEligible"
          : "newSession.autoDeviceHint",
      );
    const cloudDisabledReason = environmentCloudDisabledReason(props.params.place.modelControl);
    const hostDisabledReason = props.params.place.modelControl.hostEnvironmentDisabledReason();
    const hostedLoading = props.params.place.modelControl.hostedEnvironmentsLoading();
    const busy =
      props.params.submitting ||
      props.params.place.suggestedCloudProfile.pending ||
      props.params.pendingPlacement;
    return {
      cloudSelection,
      cloudDisabledReason,
      hostDisabledReason,
      hostedLoading,
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
    };
  });
  const busy = () => saving() || view().busy;
  function CloudHeading(heading: { pending?: boolean }) {
    return (
      <EnvironmentHeading
        label={t("newSession.cloud")}
        action="manage-cloud-workers"
        disabled={busy()}
        onAction={
          props.params.place.isAdmin() && !heading.pending && !view().showSuggestion
            ? () => {
                props.params.place.browser.close();
                props.params.onNavigate("cloud-workers");
              }
            : undefined
        }
      />
    );
  }
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
          props.state.kind === "cloud" && view().cloudPresentation.label
            ? t("newSession.cloudWorkerProvider", { provider: view().cloudPresentation.label })
            : undefined,
        "data-cloud-profile": props.params.place.cloudProfileId || undefined,
        "data-hosted-runtime": props.state.hostedRuntimeId || undefined,
        "data-machine-class": view().cloudSelection.machineClass || undefined,
        "data-os": view().cloudSelection.os || undefined,
        "data-device-id": props.params.place.deviceId || undefined,
        "data-auto-device": props.params.place.autoDevice ? "true" : undefined,
      }}
      params={props.params}
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
              value={props.params.place.browser.environmentQuery}
              disabled={busy()}
              onInput={(event: Event) => {
                if (event.currentTarget instanceof HTMLInputElement) {
                  props.params.place.browser.changeEnvironmentQuery(event.currentTarget.value);
                }
              }}
            />
          </label>
          <div class="new-session-page__environment-list">
            <Show when={view().showLocal || view().devices.length || view().showAuto}>
              <EnvironmentHeading
                label={t("newSession.yourDevices")}
                action="connect-machine"
                disabled={busy()}
                onAction={props.params.place.isAdmin() ? props.params.onConnectMachine : undefined}
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
                  aria-pressed={props.params.place.autoDevice ? "true" : "false"}
                  aria-description={view().autoHelp}
                  disabled={
                    busy() ||
                    (!props.params.place.autoDevice &&
                      Boolean(props.state.autoDeviceDisabledReason))
                  }
                  ref={nativeListener("click", () => props.params.place.selectDevice("", true))}
                >
                  <span class="session-menu__icon" aria-hidden="true">
                    <DevicePoolIcon />
                  </span>
                  <span class="session-menu__text">{t("newSession.autoDeviceChoose")}</span>
                  <span class="session-menu__check" aria-hidden="true">
                    {props.params.place.autoDevice ? <Icon name="check" /> : undefined}
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
                  checked: props.state.kind === "local",
                  disabled: Boolean(view().hostDisabledReason),
                  title: view().hostDisabledReason,
                  onSelect: () => props.params.place.selectDevice(""),
                }}
                submitting={busy()}
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
                      props.state.kind === "device" &&
                      props.params.place.deviceId === current.deviceId,
                    disabled: !current.selectable,
                    title: current.disabledReason,
                    onSelect: () => props.params.place.selectDevice(device().deviceId),
                  };
                });
                return <SessionMenuItem item={item()} submitting={busy()} />;
              }}
            </For>
            <Loading
              on={cloudProfilesCompletion()}
              fallback={
                props.params.place.canWrite() && view().devices.length === 0
                  ? renderEnvironmentSkeletons("devices")
                  : undefined
              }
            >
              {cloudProfilesRead()}
            </Loading>
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
                      checked: props.state.hostedRuntimeId === entry().id,
                      disabled: Boolean(entry().disabledReason),
                      title: entry().disabledReason,
                      onSelect: () => props.params.place.selectHostedEnvironment(entry().id),
                    }}
                    submitting={busy()}
                  />
                )}
              </For>
            }
            {view().showHostedSetup && view().hostedLoading ? (
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
              when={view().cloudProfiles.length}
              fallback={
                <Loading
                  on={cloudProfilesCompletion()}
                  fallback={
                    props.params.place.isAdmin() && props.params.place.canWrite() ? (
                      <CloudHeading pending />
                    ) : view().showSuggestion || view().showMissingCloud ? (
                      <CloudHeading />
                    ) : undefined
                  }
                >
                  {cloudProfilesRead()}
                  <Show when={view().showSuggestion || view().showMissingCloud}>
                    <CloudHeading />
                  </Show>
                </Loading>
              }
            >
              <CloudHeading />
            </Show>
            {view().showSuggestion ? (
              <SessionMenuItem
                item={{
                  value: "suggested-cloud",
                  label: t("newSession.cloud"),
                  icon: <CloudProfileIcon profile={props.params.gateway.suggestedProfile} />,
                  compact: true,
                  checked: false,
                  disabled: Boolean(view().cloudDisabledReason),
                  title: view().cloudDisabledReason,
                  onSelect: adoptSuggestedProfile,
                }}
                submitting={busy()}
              />
            ) : undefined}
            <CloudProfileMenuItems
              params={{
                profiles: view().cloudProfiles,
                selectedId: props.params.place.cloudProfileId,
                selectedOs: props.state.selectedOsId,
                selectedMachine: props.state.selectedMachineId,
                onSelectOs: (id) => selectCloudOption("os", id),
                onSelectMachine: (id) => selectCloudOption("machine", id),
                submitting: busy(),
                disabled: Boolean(view().cloudDisabledReason),
                disabledReason: view().cloudDisabledReason,
                profileDisabledReason: (profile) =>
                  environmentCloudDisabledReason(props.params.place.modelControl, profile),
                onSelect: (id, useDefaults) => {
                  if (useDefaults) {
                    props.params.place.cloudMachines.applyPending(id);
                  }
                  props.params.place.selectCloudProfile(id);
                },
              }}
            />
            <Loading
              on={cloudProfilesCompletion()}
              fallback={
                props.params.place.isAdmin() &&
                props.params.place.canWrite() &&
                view().cloudProfiles.length === 0
                  ? renderEnvironmentSkeletons("cloud")
                  : undefined
              }
            >
              {cloudProfilesRead()}
            </Loading>
            {view().showMissingCloud ? (
              <SessionMenuItem
                item={{
                  value: `cloud:${props.params.place.cloudProfileId}`,
                  label: props.params.place.cloudProfileId,
                  icon: <Icon name="cloud" />,
                  description: t("newSession.catalogUnavailable"),
                  compact: true,
                  checked: true,
                  disabled: true,
                  title: t("newSession.catalogUnavailable"),
                  onSelect: () => undefined,
                }}
                submitting={busy()}
              />
            ) : undefined}
            <Loading on={cloudProfilesCompletion()}>
              {cloudProfilesRead()}
              {!view().showLocal &&
              view().devices.length === 0 &&
              view().cloudProfiles.length === 0 &&
              view().hosted.length === 0 &&
              !view().showHostedSetup &&
              !view().showMissingCloud &&
              !view().showSuggestion ? (
                <div class="new-session-page__environment-empty" role="status">
                  {t("newSession.environmentSearchEmpty")}
                </div>
              ) : undefined}
            </Loading>
          </div>
        </div>
      </div>
    </SessionPicker>
  );
}
