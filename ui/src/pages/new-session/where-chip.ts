import type {
  WorkerMachineOption,
  WorkerOperatingSystem,
} from "../../../../packages/gateway-protocol/src/schema/environments.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import {
  projectDevicePlacements,
  resolveAutomaticDevicePlacementDisabledReason,
  type DevicePlacementOption,
  type DevicePlacementRequirement,
} from "./device-placement.ts";
import {
  cloudMachinesForOs,
  defaultCloudMachine,
  defaultCloudOs,
  type DraftCloudProfile,
  type DraftEnvironment,
} from "./discovery.ts";

registerNewSessionSetupEnglish();

type WhereChipState = Readonly<{
  kind: "local" | "device" | "auto-device" | "cloud" | "hosted";
  label: string;
  devices: readonly DevicePlacementOption[];
  cloudProfiles: readonly DraftCloudProfile[];
  cloudMachines: readonly WorkerMachineOption[];
  selectedMachineId: string;
  operatingSystems: readonly WorkerOperatingSystem[];
  selectedOsId: string;
  autoDeviceDisabledReason?: string;
  hostedRuntimeId?: string;
}>;

export function resolveWhereChip(params: {
  hostedEnvironment?: { id: string; label: string };
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
  if (params.hostedEnvironment) {
    return {
      kind: "hosted",
      label: params.hostedEnvironment.label,
      hostedRuntimeId: params.hostedEnvironment.id,
      devices,
      cloudProfiles: params.cloudProfiles,
      cloudMachines: [],
      selectedMachineId: "",
      operatingSystems: [],
      selectedOsId: "",
      autoDeviceDisabledReason,
    };
  }
  if (params.cloudProfileId) {
    const defaultOs = profile ? defaultCloudOs(profile) : "";
    const selectedOsId = params.os || defaultOs;
    const operatingSystems = profile?.operatingSystems ?? [];
    const cloudMachines = profile ? cloudMachinesForOs(profile, selectedOsId) : [];
    const defaultMachine = profile ? defaultCloudMachine(profile, selectedOsId) : undefined;
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
  return {
    kind: params.deviceId ? "device" : params.autoDevice ? "auto-device" : "local",
    label: params.deviceId
      ? (device?.label ?? params.deviceId)
      : t(params.autoDevice ? "newSession.autoDevice" : "newSession.local"),
    cloudMachines: [],
    selectedMachineId: "",
    operatingSystems: [],
    selectedOsId: "",
    devices,
    cloudProfiles: params.cloudProfiles,
    autoDeviceDisabledReason,
  };
}

export type WhereChipOptions = {
  hostedEnvironments?: readonly {
    id: string;
    label: string;
    disabledReason?: string;
    model?: string;
  }[];
  onSelectHostedEnvironment?: (id: string) => void;
  hostDisabledReason?: string;
  hostedLoading?: boolean;
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
  cloudDisabledReason?: string;
  cloudProfileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  submitting: boolean;
  pendingPlacement: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  isAdmin: boolean;
  catalogLoading?: boolean;
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
};
