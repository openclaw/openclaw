import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { workerCapacityPresentation } from "../../components/worker-capacity.ts";
import { t } from "../../i18n/index.ts";
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

export function renderWhereChip(params: {
  autoPlacementMode?: "least-busy" | "eligible-order";
  state: WhereChipState;
  gatewayName: string;
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
  onSelectAutoDevice: () => void;
  onSelectCloudProfile: (profileId: string) => void;
  onSelectCloudOs?: (osId: string) => void;
  onSelectCloudMachine?: (machineId: string) => void;
  onConnectMachine: () => void;
}) {
  const icon = params.state.kind === "cloud" ? icons.server : icons.monitor;
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
      @wa-show=${params.onPopoverShow}
      @wa-hide=${params.onPopoverHide}
      @wa-after-hide=${params.onPopoverAfterHide}
    >
      <div class="new-session-page__picker-root">
        <div class="new-session-page__menu-title">${t("newSession.environments")}</div>
        ${renderSessionMenuItem(
          {
            value: "gateway",
            label: t("newSession.local"),
            icon: icons.monitor,
            sub: params.gatewayName || undefined,
            checked: !params.deviceId && !params.autoDevice && !params.cloudProfileId,
            title: gatewayTitle,
            onSelect: () => params.onSelectDevice(""),
          },
          params.submitting,
        )}
        ${
          params.state.devices.length > 0
            ? html`
                <div class="new-session-page__menu-title">${t("newSession.yourDevices")}</div>
                ${renderSessionMenuItem(
                  {
                    value: "auto-device",
                    label: t("newSession.autoDevice"),
                    sub: t(
                      params.autoPlacementMode === "eligible-order"
                        ? "newSession.autoDeviceSubEligible"
                        : "newSession.autoDeviceSub",
                    ),
                    icon: icons.monitor,
                    checked: params.autoDevice === true,
                    disabled: Boolean(params.state.autoDeviceDisabledReason),
                    title: params.state.autoDeviceDisabledReason,
                    facts: params.state.autoDeviceDisabledReason
                      ? [params.state.autoDeviceDisabledReason]
                      : undefined,
                    onSelect: params.onSelectAutoDevice,
                  },
                  params.submitting,
                )}
                ${params.state.devices.map((device) => {
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
                      icon: icons.monitor,
                      facts: device.facts,
                      meter: capacity?.meter,
                      checked: params.deviceId === device.deviceId,
                      disabled: !device.selectable,
                      title:
                        [device.disabledReason, capacity?.title].filter(Boolean).join(" · ") ||
                        undefined,
                      onSelect: () => params.onSelectDevice(device.deviceId),
                    },
                    params.submitting,
                  );
                })}
              `
            : nothing
        }
        ${
          params.isAdmin && (params.state.cloudProfiles.length > 0 || params.cloudProfileId)
            ? html`
                <div class="new-session-page__menu-title">${t("newSession.cloud")}</div>
                ${renderCloudProfileMenuItems({
                  profiles: params.state.cloudProfiles,
                  selectedId: params.cloudProfileId,
                  submitting: params.submitting,
                  icon: icons.server,
                  disabled: !params.worktreeAvailable || Boolean(params.cloudDisabledReason),
                  disabledReason: params.cloudDisabledReason,
                  profileDisabledReason: params.cloudProfileDisabledReason,
                  onSelect: params.onSelectCloudProfile,
                })}
                ${
                  params.cloudProfileId &&
                  !params.state.cloudProfiles.some(
                    (profile) => profile.id === params.cloudProfileId,
                  )
                    ? renderSessionMenuItem(
                        {
                          value: `cloud:${params.cloudProfileId}`,
                          label: t("newSession.cloudWorker", { profile: params.cloudProfileId }),
                          icon: icons.server,
                          checked: true,
                          disabled: true,
                          title: t("newSession.catalogUnavailable"),
                          onSelect: () => undefined,
                        },
                        params.submitting,
                      )
                    : nothing
                }
              `
            : nothing
        }
        ${
          params.state.kind === "cloud" && params.state.operatingSystems.length >= 2
            ? html`
                <div class="new-session-page__menu-title">${t("newSession.operatingSystem")}</div>
                ${renderCloudOsMenuItems({
                  operatingSystems: params.state.operatingSystems,
                  selectedId: params.state.selectedOsId,
                  submitting: params.submitting,
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
                  submitting: params.submitting,
                  onSelect: params.onSelectCloudMachine ?? (() => undefined),
                })}
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
