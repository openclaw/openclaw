import WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { html, nothing, svg } from "lit";
import { ref } from "lit/directives/ref.js";
import { deviceIcons } from "../../components/icons-devices.ts";
import { strokeIcon } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { resolveMacFormFactorFromName } from "../../lib/mac-form-factor.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { renderCloudProfileMenuItems, renderSessionMenuItem } from "./cloud-target.ts";
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
import { environmentCapabilityLabels } from "./place-facts.ts";

const devicePoolIcon = strokeIcon(svg`<rect x="2" y="7" width="14" height="11" />
  <path d="M6 7V3h16v12h-6M6 22h6M9 18v4" />`);
const connectDeviceIcon = strokeIcon(svg`<circle cx="12" cy="12" r="9" />
  <path d="M12 8v8M8 12h8" />`);

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
    const cloudMachines = profile ? cloudMachinesForOs(profile, selectedOsId) : [];
    const defaultMachine = cloudMachines.find((machine) => machine.default === true);
    const selectedMachine = params.machineClass
      ? cloudMachines.find((machine) => machine.id === params.machineClass)
      : defaultMachine;
    return {
      kind: "cloud",
      label: profile?.id ?? params.cloudProfileId,
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
  onSelectAutoDevice: () => void;
  onSelectCloudProfile: (profileId: string, useDefaults?: boolean) => void;
  onSelectCloudOs?: (osId: string) => void;
  onSelectCloudMachine?: (machineId: string) => void;
  onConnectMachine: () => void;
  onManageCloudWorkers: () => void;
}) {
  const icon =
    params.state.kind === "cloud"
      ? icons.cloud
      : params.state.kind === "local"
        ? icons.home
        : params.state.kind === "auto-device"
          ? devicePoolIcon
          : environmentDeviceIcon(
              params.state.devices.find((device) => device.deviceId === params.deviceId),
            );
  const localName = params.gatewayName.trim() || t("newSession.local");
  const label = params.state.kind === "local" ? localName : params.state.label;
  const configurationSummary =
    params.state.kind === "cloud"
      ? [
          params.state.operatingSystems.find((os) => os.id === params.state.selectedOsId)?.label,
          params.state.cloudMachines.find(
            (machine) => machine.id === params.state.selectedMachineId,
          )?.label,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  const query = params.environmentQuery.trim().toLocaleLowerCase();
  const matches = (...values: (string | undefined)[]) =>
    values.some((value) => value?.toLocaleLowerCase().includes(query));
  const showLocal = matches(t("newSession.local"), t("newSession.gatewayHost"), params.gatewayName);
  const devices = params.state.devices
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
  const showAuto =
    params.state.devices.length > 1 &&
    (devices.length > 0 || matches(t("newSession.autoDeviceChoose"), t("newSession.autoDevice")));
  const autoHelp =
    params.state.autoDeviceDisabledReason ??
    t(
      params.autoPlacementMode === "eligible-order"
        ? "newSession.autoDeviceHintEligible"
        : "newSession.autoDeviceHint",
    );
  const busy = params.submitting || params.pendingPlacement;
  const destinationDisabled = busy;
  let cleanupScrollFade: (() => void) | undefined;
  const bindScrollFade = (element: Element | undefined) => {
    cleanupScrollFade?.();
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const update = () => {
      const overflow = element.scrollHeight - element.clientHeight;
      element.toggleAttribute("data-fade-top", overflow > 1 && element.scrollTop > 1);
      element.toggleAttribute("data-fade-bottom", overflow > 1 && element.scrollTop < overflow - 1);
    };
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resize?.observe(element);
    const content = new MutationObserver(update);
    content.observe(element, { childList: true, subtree: true, characterData: true });
    element.addEventListener("scroll", update, { passive: true });
    cleanupScrollFade = () => {
      resize?.disconnect();
      content.disconnect();
      element.removeEventListener("scroll", update);
    };
    update();
  };
  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-where-trigger"
        type="button"
        class="new-session-page__trigger ${
          params.popoverHiding ? "new-session-page__trigger--hiding" : ""
        }"
        aria-label="${t("newSession.where")}: ${label}${
          configurationSummary ? `, ${configurationSummary}` : ""
        }"
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
        <span class="new-session-page__trigger-label">${label}</span>
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
      @wa-hide=${(event: Event) => {
        if (event.target === event.currentTarget) {
          params.onPopoverHide();
        }
      }}
      @wa-after-hide=${(event: Event) => {
        if (event.target === event.currentTarget) {
          params.onPopoverAfterHide();
        }
      }}
    >
      <div class="new-session-page__environment-layout">
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
          <div ${ref(bindScrollFade)} class="new-session-page__environment-list">
            ${
              showLocal || devices.length || showAuto
                ? html`<div
                    class="new-session-page__environment-heading new-session-page__devices-heading"
                  >
                    <span>${t("newSession.yourDevices")}</span>
                    ${
                      params.isAdmin
                        ? html`<button
                            type="button"
                            class="new-session-page__connect-device"
                            data-action="connect-machine"
                            aria-label=${t("newSession.connectMachine")}
                            ?disabled=${busy}
                            @click=${params.onConnectMachine}
                          >
                            ${connectDeviceIcon}
                          </button>`
                        : nothing
                    }
                  </div>`
                : nothing
            }
            ${
              showAuto
                ? html`<openclaw-tooltip
                    class="new-session-page__environment-details"
                    placement="right-start"
                  >
                    <button
                      type="button"
                      class="session-menu__item new-session-page__environment-option"
                      data-value="auto-device"
                      data-popover="close"
                      aria-pressed=${String(params.autoDevice === true)}
                      aria-description=${autoHelp}
                      ?disabled=${
                        busy ||
                        (!params.autoDevice && Boolean(params.state.autoDeviceDisabledReason))
                      }
                      @click=${params.onSelectAutoDevice}
                    >
                      <span class="session-menu__icon" aria-hidden="true">${devicePoolIcon}</span>
                      <span class="session-menu__text">${t("newSession.autoDeviceChoose")}</span>
                      <span class="session-menu__check" aria-hidden="true"
                        >${params.autoDevice ? icons.check : nothing}</span
                      >
                    </button>
                    <div slot="content" class="new-session-page__environment-card">
                      <strong>${t("newSession.autoDeviceChoose")}</strong>
                      <div class="new-session-page__card-row">
                        <span class="new-session-page__card-icon" aria-hidden="true"
                          >${icons.info}</span
                        >
                        <span>${autoHelp}</span>
                      </div>
                    </div>
                  </openclaw-tooltip>`
                : nothing
            }
            ${
              showLocal
                ? renderSessionMenuItem(
                    {
                      value: "gateway",
                      label: localName,
                      icon: icons.home,
                      summary: t("newSession.runsOnGateway"),
                      compact: true,
                      checked: params.state.kind === "local",
                      onSelect: () => params.onSelectDevice(""),
                    },
                    destinationDisabled,
                  )
                : nothing
            }
            ${devices.map((device) => {
              return renderSessionMenuItem(
                {
                  value: `device:${device.deviceId}`,
                  label: device.label,
                  sub: device.subtitle,
                  icon: environmentDeviceIcon(device),
                  platform: device.platform ? prettifyPlatform(device.platform) : undefined,
                  capabilityLabels: environmentCapabilityLabels(device.capabilities),
                  hideDetails: device.hideDetails,
                  remediation: device.remediation,
                  capacityLabel:
                    device.selectable && device.workerSlots
                      ? t("newSession.concurrentSessionsValue", {
                          used: String(device.workerSlots.total - device.workerSlots.available),
                          total: String(device.workerSlots.total),
                        })
                      : undefined,
                  compact: true,
                  checked: params.state.kind === "device" && params.deviceId === device.deviceId,
                  disabled: !device.selectable,
                  title: device.disabledReason,
                  onSelect: () => params.onSelectDevice(device.deviceId),
                },
                destinationDisabled,
              );
            })}
            ${
              cloudProfiles.length || showMissingCloud
                ? html`<div
                    class="new-session-page__environment-heading new-session-page__devices-heading"
                  >
                    <span>${t("newSession.cloud")}</span>
                    ${
                      params.isAdmin
                        ? html`<button
                            type="button"
                            class="new-session-page__connect-device"
                            data-action="manage-cloud-workers"
                            aria-label=${t("newSession.manageCloudWorkers")}
                            ?disabled=${busy}
                            @click=${params.onManageCloudWorkers}
                          >
                            ${connectDeviceIcon}
                          </button>`
                        : nothing
                    }
                  </div>`
                : nothing
            }
            ${renderCloudProfileMenuItems({
              profiles: cloudProfiles,
              selectedId: params.cloudProfileId,
              selectedOs: params.state.selectedOsId,
              selectedMachine: params.state.selectedMachineId,
              onSelectOs: params.onSelectCloudOs,
              onSelectMachine: params.onSelectCloudMachine,
              submitting: destinationDisabled,
              icon: icons.cloud,
              compact: true,
              disabled: !params.worktreeAvailable || Boolean(params.cloudDisabledReason),
              disabledReason:
                params.cloudDisabledReason ??
                (!params.worktreeAvailable ? t("newSession.cloudRequiresWorktree") : undefined),
              profileDisabledReason: params.cloudProfileDisabledReason,
              onSelect: params.onSelectCloudProfile,
            })}
            ${
              showMissingCloud
                ? renderSessionMenuItem(
                    {
                      value: `cloud:${params.cloudProfileId}`,
                      label: params.cloudProfileId,
                      icon: icons.cloud,
                      description: t("newSession.catalogUnavailable"),
                      compact: true,
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
          </div>
        </div>
      </div>
    </wa-popover>
  `;
}
