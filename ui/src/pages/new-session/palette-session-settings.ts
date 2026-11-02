import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import type { NewSessionDraft } from "./draft.ts";
import { environmentCloudDisabledReason } from "./hosted-environments.ts";
import type { PaletteSessionPreferences } from "./palette-session-preferences.ts";
import { resolveProjectChip } from "./project-chip.ts";
import { draftWhereChipParams, resolveWhereChip } from "./where-chip.ts";
import "../../styles/palette-session-settings.css";

registerNewSessionSetupEnglish();

registerCommandPaletteEnglish();

export type SettingsOptions = {
  draft: NewSessionDraft;
  context: ApplicationContext | undefined;
  preferences: PaletteSessionPreferences;
  identityTargetsRef: (read: () => readonly string[]) => void;
  onIdentityTargetsChange: () => void;
  onChange: () => void;
  onConnectMachine: () => void;
};

export function resolvePaletteSessionSettings(options: SettingsOptions, search: string) {
  const { draft } = options;
  const { place, gateway, submission } = draft;
  const placementLocked = place.requiredPlacement;
  const locked =
    submission.submitting ||
    Boolean(submission.pendingPlacement.sessionKey) ||
    Boolean(submission.submissionOutcomeUnknown);
  const where = resolveWhereChip(draftWhereChipParams(place, gateway));
  const machineLabel =
    where.kind === "local" ? gateway.gatewayName || t("newSession.local") : where.label;
  const cloudSummary = [
    where.operatingSystems.find((os) => os.id === where.selectedOsId)?.label,
    where.cloudMachines.find((machine) => machine.id === where.selectedMachineId)?.label,
  ]
    .filter(Boolean)
    .join(" · ");
  const projectState = resolveProjectChip({
    folder: place.folder,
    workspace: place.workspacePath(),
    projectId: draft.browser.projectId,
    selectedRemoteProject: draft.browser.remoteProject,
    projects: draft.browser.projects,
    recents: [],
    projectQuery: "",
    freshWorkspace: place.freshWorkspace,
  });
  const machines: {
    id: string;
    label: string;
    remote: boolean;
    hosted?: boolean;
    selected: boolean;
    disabledReason?: string;
    select: () => void;
  }[] = [
    ...place.modelControl.hostedEnvironments().map((environment) => ({
      id: "runtime:" + environment.id,
      label: environment.label,
      hosted: true,
      remote: false,
      selected: where.hostedRuntimeId === environment.id,
      disabledReason: environment.disabledReason,
      select: () => place.selectHostedEnvironment(environment.id),
    })),
    {
      id: "local",
      label: gateway.gatewayName || t("newSession.local"),
      remote: false,
      selected: !place.hostedEnvironment && !place.remotePlacement,
      disabledReason: place.modelControl.hostEnvironmentDisabledReason(),
      select: () => place.selectDevice(""),
    },
    ...where.devices.map((device) => ({
      id: "device:" + device.deviceId,
      label: device.label,
      remote: true,
      selected: place.deviceId === device.deviceId,
      disabledReason: device.disabledReason,
      select: () => place.selectDevice(device.deviceId),
    })),
    ...(where.devices.length
      ? [
          {
            id: "auto-device",
            label: t("newSession.autoDevice"),
            remote: true,
            selected: place.autoDevice,
            disabledReason: where.autoDeviceDisabledReason,
            select: () => place.selectDevice("", true),
          },
        ]
      : []),
    ...where.cloudProfiles.map((profile) => ({
      id: "cloud:" + profile.id,
      label: t("newSession.cloudWorker", { profile: profile.id }),
      remote: true,
      selected: place.cloudProfileId === profile.id,
      disabledReason: environmentCloudDisabledReason(place.modelControl, profile),
      select: () => place.selectCloudProfile(profile.id),
    })),
  ];
  const query = search.trim().toLocaleLowerCase().normalize("NFC");
  const groups = machines
    .map((machine) => ({
      machine,
      choices: (machine.disabledReason || machine.hosted
        ? [
            {
              id: "",
              label: t(
                machine.disabledReason
                  ? "newSession.environmentUnavailable"
                  : "newSession.hostedWorkspace",
              ),
            },
          ]
        : [
            {
              id: "",
              label: machine.remote
                ? t("newSession.newWorkspace")
                : pathDisplayName(place.workspacePath()) || t("newSession.folderPlaceholder"),
            },
            ...draft.browser.projects.map((project) => ({
              id: project.id,
              label: project.displayName,
            })),
          ]
      ).filter(
        (choice) =>
          !query ||
          (machine.label + " " + choice.label).toLocaleLowerCase().normalize("NFC").includes(query),
      ),
    }))
    .filter((group) => group.choices.length);
  return {
    placementLocked,
    locked,
    machineLabel,
    cloudSummary,
    projectState,
    groups,
  };
}
