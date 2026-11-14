import { createMemo, lazy } from "solid-js";
import { resolveCloudProfileIconData } from "../../components/cloud-profile-icon-data.ts";
import { CloudProfileIcon } from "../../components/solid/cloud-profile-icon.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import type { PopoverHandle } from "../../components/solid/popover.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { SessionPicker } from "./picker.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";
import { DevicePoolIcon, EnvironmentDeviceIcon } from "./where-chip-icons.tsx";
import type { resolveWhereChip } from "./where-chip.ts";

const WherePickerContent = lazy(() => import("./where-picker-content.tsx"), {
  export: "WherePickerContent",
});

export type WhereChipProps = {
  params: NewSessionPlaceControlsOptions;
  state: ReturnType<typeof resolveWhereChip>;
  ref?: (handle: PopoverHandle) => void;
};

export function WhereChip(props: WhereChipProps) {
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
    return { cloudSelection, cloudPresentation, label, configurationSummary };
  });
  return (
    <SessionPicker
      lazy
      ref={props.ref}
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
      <WherePickerContent params={props.params} state={props.state} />
    </SessionPicker>
  );
}
