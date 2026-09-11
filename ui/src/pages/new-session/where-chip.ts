import WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { html, nothing, svg } from "lit";
import { deviceIcons } from "../../components/icons-devices.ts";
import { strokeIcon } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import { workerCapacityPresentation } from "../../components/worker-capacity.ts";
import { t } from "../../i18n/index.ts";
import { resolveMacFormFactorFromName } from "../../lib/mac-form-factor.ts";
import {
  renderCloudProfileMenuItems,
  renderCloudMachineMenuItems,
  renderCloudOsMenuItems,
  renderConnectMachineMenuItem,
  renderSessionMenuItem,
} from "./cloud-target.ts";
import {
  projectDevicePlacements,
  resolveAutomaticDevicePlacementDisabledReason,
  type DevicePlacementOption,
  type DevicePlacementRequirement,
} from "./device-placement.ts";
import {
  cloudMachinesForOs,
  defaultCloudOs,
  type DraftCloudProfile,
  type DraftEnvironment,
  type DraftMachineOption,
  type DraftOperatingSystem,
} from "./discovery.ts";

const shuffleIcon = strokeIcon(svg`<path d="m18 14 4 4-4 4" />
  <path d="m18 2 4 4-4 4" />
  <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
  <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
  <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />`);

type WhereChipState = Readonly<{
  kind: "local" | "device" | "auto-device" | "cloud";
  label: string;
  devices: readonly DevicePlacementOption[];
  cloudProfiles: readonly DraftCloudProfile[];
  cloudMachines: readonly DraftMachineOption[];
  selectedMachineId: string;
  operatingSystems: readonly DraftOperatingSystem[];
  selectedOsId: string;
  autoDeviceDisabledReason?: string;
}>;

export function resolveWhereChip(params: {
  environments: readonly DraftEnvironment[] | null;
  cloudProfiles: readonly DraftCloudProfile[];
  cloudProfileId: string;
  machineClass?: string;
  os?: string;
  deviceId: string;
  autoDevice?: boolean;
  devicePlacement?: DevicePlacementRequirement;
  deviceDisabledReason?: string;
}): WhereChipState {
  const devices = projectDevicePlacements(
    params.environments,
    params.devicePlacement,
    params.deviceDisabledReason,
  );
  const autoDeviceDisabledReason = resolveAutomaticDevicePlacementDisabledReason(
    params.environments,
    devices,
    params.deviceDisabledReason,
  );
  const device = devices.find((candidate) => candidate.deviceId === params.deviceId);
  const profile = params.cloudProfiles.find((candidate) => candidate.id === params.cloudProfileId);
  if (params.cloudProfileId) {
    const defaultOs = profile ? defaultCloudOs(profile) : "";
    const selectedOsId = params.os || defaultOs;
    const operatingSystems = profile?.operatingSystems ?? [];
    const osLabel =
      params.os && params.os !== defaultOs
        ? (operatingSystems.find((os) => os.id === params.os)?.label ?? params.os)
        : "";
    const cloudMachines = profile ? cloudMachinesForOs(profile, selectedOsId) : [];
    const defaultMachine = cloudMachines.find((machine) => machine.default === true);
    const selectedMachine = params.machineClass
      ? cloudMachines.find((machine) => machine.id === params.machineClass)
      : defaultMachine;
    return {
      kind: "cloud",
      label: osLabel
        ? params.machineClass
          ? t("newSession.cloudWorkerOsMachine", {
              profile: profile?.id ?? params.cloudProfileId,
              os: osLabel,
              machine: selectedMachine?.label ?? params.machineClass,
            })
          : t("newSession.cloudWorkerOs", {
              profile: profile?.id ?? params.cloudProfileId,
              os: osLabel,
            })
        : params.machineClass
          ? t("newSession.cloudWorkerMachine", {
              profile: profile?.id ?? params.cloudProfileId,
              machine: selectedMachine?.label ?? params.machineClass,
            })
          : (profile?.id ?? params.cloudProfileId),
      operatingSystems,
      selectedOsId,
      cloudMachines,
      selectedMachineId: selectedMachine?.id ?? "",
      devices,
      cloudProfiles: params.cloudProfiles,
      autoDeviceDisabledReason,
    };
  }
  if (params.deviceId) {
    return {
      kind: "device",
      label: device?.label ?? params.deviceId,
      cloudMachines: [],
      selectedMachineId: "",
      operatingSystems: [],
      selectedOsId: "",
      devices,
      cloudProfiles: params.cloudProfiles,
      autoDeviceDisabledReason,
    };
  }
  if (params.autoDevice) {
    return {
      kind: "auto-device",
      label: t("newSession.autoDevice"),
      cloudMachines: [],
      selectedMachineId: "",
      operatingSystems: [],
      selectedOsId: "",
      devices,
      cloudProfiles: params.cloudProfiles,
      autoDeviceDisabledReason,
    };
  }
  return {
    kind: "local",
    label: t("newSession.local"),
    cloudMachines: [],
    selectedMachineId: "",
    operatingSystems: [],
    selectedOsId: "",
    devices,
    cloudProfiles: params.cloudProfiles,
    autoDeviceDisabledReason,
  };
}

function environmentDeviceIcon(device?: DevicePlacementOption) {
  const platform = device?.platform?.trim();
  if (platform && !/^(?:darwin|macos|mac os(?: x)?)\b/i.test(platform)) {
    return icons.monitor;
  }
  const form = resolveMacFormFactorFromName(device?.label);
  const icon =
    form === "laptop"
      ? deviceIcons.laptop
      : form === "mini"
        ? deviceIcons.macMini
        : form === "studio"
          ? deviceIcons.macStudio
          : undefined;
  if (!icon) {
    return icons.monitor;
  }
  return html`<span class="new-session-page__device-icon" data-form=${form}>${icon}</span>`;
}

export function renderWhereChip(params: {
  autoPlacementMode?: "least-busy" | "eligible-order";
  state: WhereChipState;
  gatewayName: string;
  environmentQuery: string;
  onEnvironmentQueryInput: (query: string) => void;
  cloudProfileId: string;
  machineClass?: string;
  os?: string;
  deviceId: string;
  autoDevice?: boolean;
  worktreeAvailable: boolean;
  cloudDisabledReason?: string;
  cloudProfileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  submitting: boolean;
  pendingPlacement: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  isAdmin: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onSelectDevice: (deviceId: string) => void;
  onToggleAutoDevice: (enabled: boolean) => void;
  onSelectCloudProfile: (profileId: string) => void;
  onSelectCloudOs?: (osId: string) => void;
  onSelectCloudMachine?: (machineId: string) => void;
  onConnectMachine: () => void;
}) {
  const icon =
    params.state.kind === "cloud"
      ? icons.cloud
      : params.state.kind === "local"
        ? icons.home
        : params.state.kind === "auto-device"
          ? shuffleIcon
          : environmentDeviceIcon(
              params.state.devices.find((device) => device.deviceId === params.deviceId),
            );
  const query = params.environmentQuery.trim().toLocaleLowerCase();
  const matches = (...values: (string | undefined)[]) =>
    values.some((value) => value?.toLocaleLowerCase().includes(query));
  const showLocal = matches(t("newSession.local"), t("newSession.gatewayHost"), params.gatewayName);
  const devices = params.state.devices.filter((device) =>
    matches(
      t("newSession.device"),
      t("newSession.yourDevices"),
      device.label,
      device.deviceId,
      ...device.facts,
    ),
  );
  const cloudProfiles = params.isAdmin
    ? params.state.cloudProfiles.filter((profile) =>
        matches(
          t("newSession.cloud"),
          profile.id,
          profile.providerId,
          profile.trust === "disposable"
            ? t("newSession.environmentDisposable")
            : profile.trust === "persistent"
              ? t("newSession.environmentPersistent")
              : undefined,
        ),
      )
    : [];
  const showMissingCloud =
    params.isAdmin &&
    Boolean(params.cloudProfileId) &&
    !params.state.cloudProfiles.some((profile) => profile.id === params.cloudProfileId) &&
    matches(t("newSession.cloud"), params.cloudProfileId);
  const busy = params.submitting || params.pendingPlacement;
  const destinationDisabled = busy || params.autoDevice === true;
  const gatewayTitle = params.gatewayName
    ? t("newSession.gatewayNamed", { name: params.gatewayName })
    : t("newSession.gateway");
  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-where-trigger"
        type="button"
        class="new-session-page__trigger ${
          params.popoverHiding ? "new-session-page__trigger--hiding" : ""
        }"
        title=${t("newSession.where")}
        aria-label="${t("newSession.where")}: ${params.state.label}"
        data-cloud-profile=${params.cloudProfileId || nothing}
        data-machine-class=${params.machineClass || nothing}
        data-os=${params.os || nothing}
        data-device-id=${params.deviceId || nothing}
        data-auto-device=${params.autoDevice ? "true" : nothing}
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.submitting || params.pendingPlacement}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true">${icon}</span>
        <span class="new-session-page__trigger-label">${params.state.label}</span>
        <span
          class="new-session-page__trigger-chevron new-session-page__trigger-chevron--desktop"
          aria-hidden="true"
          >${icons.chevronDown}</span
        >
        <span
          class="new-session-page__trigger-chevron new-session-page__trigger-chevron--mobile"
          aria-hidden="true"
          >${icons.chevronsUpDown}</span
        >
      </button>
    </span>
    <wa-popover
      class="new-session-page__select new-session-page__where-popover new-session-page__picker-popover"
      for="new-session-where-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${(event: Event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.currentTarget instanceof WaPopover) {
          // Let the positioning owner recompute the scroll budget on open and resize.
          event.currentTarget.popup.autoSize = "vertical";
          event.currentTarget.popup.autoSizePadding = 8;
        }
        params.onPopoverShow();
      }}
      @wa-hide=${params.onPopoverHide}
      @wa-after-hide=${params.onPopoverAfterHide}
    >
      <div class="new-session-page__picker-root new-session-page__environment-picker">
        <label class="new-session-page__environment-search">
          <span aria-hidden="true">${icons.search}</span>
          <input
            type="search"
            autofocus
            aria-label=${t("newSession.environmentSearchPlaceholder")}
            placeholder=${t("newSession.environmentSearchPlaceholder")}
            .value=${params.environmentQuery}
            ?disabled=${busy}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                params.onEnvironmentQueryInput(event.currentTarget.value);
              }
            }}
          />
        </label>
        <div
          class="new-session-page__environment-list ${params.autoDevice ? "new-session-page__environment-list--automatic" : ""}"
        >
          ${
            showLocal
              ? renderSessionMenuItem(
                  {
                    value: "gateway",
                    label: params.gatewayName || t("newSession.local"),
                    icon: icons.home,
                    description: t("newSession.gatewayHost"),
                    stacked: true,
                    checked: params.state.kind === "local",
                    title: gatewayTitle,
                    onSelect: () => params.onSelectDevice(""),
                  },
                  destinationDisabled,
                )
              : nothing
          }
          ${devices.map((device) => {
            const capacity = workerCapacityPresentation({
              workerSlots: device.workerSlots,
              capabilities: device.capabilities,
              commands: device.invocableCommands,
              unavailable: !device.selectable,
            });
            return renderSessionMenuItem(
              {
                value: `device:${device.deviceId}`,
                label: device.label,
                sub: device.subtitle,
                icon: environmentDeviceIcon(device),
                facts: device.facts,
                meter: capacity?.meter,
                stacked: true,
                checked: params.state.kind === "device" && params.deviceId === device.deviceId,
                disabled: !device.selectable,
                title:
                  [device.disabledReason, capacity?.title].filter(Boolean).join(" · ") || undefined,
                onSelect: () => params.onSelectDevice(device.deviceId),
              },
              destinationDisabled,
            );
          })}
          ${renderCloudProfileMenuItems({
            profiles: cloudProfiles,
            selectedId: params.cloudProfileId,
            submitting: destinationDisabled,
            icon: icons.cloud,
            stacked: true,
            disabled: !params.worktreeAvailable || Boolean(params.cloudDisabledReason),
            disabledReason: params.cloudDisabledReason,
            profileDisabledReason: params.cloudProfileDisabledReason,
            onSelect: params.onSelectCloudProfile,
          })}
          ${
            showMissingCloud
              ? renderSessionMenuItem(
                  {
                    value: `cloud:${params.cloudProfileId}`,
                    label: t("newSession.cloudWorker", { profile: params.cloudProfileId }),
                    icon: icons.cloud,
                    description: t("newSession.catalogUnavailable"),
                    stacked: true,
                    checked: true,
                    disabled: true,
                    title: t("newSession.catalogUnavailable"),
                    onSelect: () => undefined,
                  },
                  destinationDisabled,
                )
              : nothing
          }
          ${
            !showLocal && devices.length === 0 && cloudProfiles.length === 0 && !showMissingCloud
              ? html`<div class="new-session-page__environment-empty" role="status">
                  ${t("newSession.environmentSearchEmpty")}
                </div>`
              : nothing
          }
          ${
            params.state.kind === "cloud" && params.state.operatingSystems.length >= 2
              ? html`
                  <div class="new-session-page__menu-title">${t("newSession.operatingSystem")}</div>
                  ${renderCloudOsMenuItems({
                    operatingSystems: params.state.operatingSystems,
                    selectedId: params.state.selectedOsId,
                    submitting: destinationDisabled,
                    onSelect: params.onSelectCloudOs ?? (() => undefined),
                  })}
                `
              : nothing
          }
          ${
            params.state.kind === "cloud" && params.state.cloudMachines.length > 0
              ? html`
                  <div class="new-session-page__menu-title">${t("newSession.machine")}</div>
                  ${renderCloudMachineMenuItems({
                    machines: params.state.cloudMachines,
                    selectedId: params.state.selectedMachineId,
                    submitting: destinationDisabled,
                    onSelect: params.onSelectCloudMachine ?? (() => undefined),
                  })}
                `
              : nothing
          }
        </div>
        ${
          params.state.devices.length > 0 || params.autoDevice
            ? html`
                <div class="new-session-page__environment-auto">
                  <button
                    type="button"
                    class="session-menu__item new-session-page__auto-device"
                    data-value="auto-device"
                    role="switch"
                    aria-checked=${String(params.autoDevice === true)}
                    aria-label=${t("newSession.autoDeviceChoose")}
                    title=${params.state.autoDeviceDisabledReason ?? nothing}
                    ?disabled=${busy || (!params.autoDevice && Boolean(params.state.autoDeviceDisabledReason))}
                    @click=${() => params.onToggleAutoDevice(!params.autoDevice)}
                  >
                    <span class="session-menu__icon" aria-hidden="true">${shuffleIcon}</span>
                    <span class="session-menu__text">
                      ${t("newSession.autoDeviceChoose")}
                      <span class="session-menu__description"
                        >${
                          params.state.autoDeviceDisabledReason ??
                          `${t("newSession.autoDeviceScope")} · ${t(
                            params.autoPlacementMode === "eligible-order"
                              ? "newSession.autoDeviceSubEligible"
                              : "newSession.autoDeviceSub",
                          )}`
                        }</span
                      >
                    </span>
                    <span class="new-session-page__auto-switch" aria-hidden="true"></span>
                  </button>
                </div>
              `
            : nothing
        }
        ${
          params.isAdmin
            ? renderConnectMachineMenuItem({
                disabled: params.submitting || params.pendingPlacement,
                onSelect: params.onConnectMachine,
              })
            : nothing
        }
      </div>
    </wa-popover>
  `;
}
