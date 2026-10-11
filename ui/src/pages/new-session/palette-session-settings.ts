import type { ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { solidContent } from "../../lit/solid-content.tsx";
import type { NewSessionDraftController } from "./draft-controller.ts";
import {
  environmentPlacementRuntime,
  environmentDeviceDisabledReason,
  environmentCloudDisabledReason,
} from "./hosted-environments.ts";
import type { PaletteSessionPreferences } from "./palette-session-preferences.ts";
import { PaletteSessionSettingsView } from "./palette-session-settings-view.tsx";
import { resolveProjectChip } from "./project-chip.ts";
import { resolveWhereChip } from "./where-chip.ts";
import "../../styles/palette-session-settings.css";

registerNewSessionSetupEnglish();

registerCommandPaletteEnglish();

export type SettingsOptions = {
  draft: NewSessionDraftController;
  context: ApplicationContext | undefined;
  preferences: PaletteSessionPreferences;
  onAgentPickerOpen: (open: boolean) => void;
  onChange: () => void;
  onConnectMachine: () => void;
};

type MachineChoice = {
  id: string;
  label: string;
  remote: boolean;
  hosted?: boolean;
  selected: boolean;
  disabledReason?: string;
  select: () => void;
};

export class PaletteSessionSettings {
  private open = false;
  private places = false;
  private query = "";

  constructor(
    private readonly host: ReactiveControllerHost &
      Pick<HTMLElement, "ownerDocument" | "querySelector" | "querySelectorAll">,
    private readonly id: string,
  ) {}

  close() {
    this.open = false;
    this.places = false;
    this.query = "";
    this.host.requestUpdate();
  }

  private async showPlaces(value: boolean, pointer = false) {
    this.places = value;
    this.query = "";
    this.host.requestUpdate();
    await this.host.updateComplete;
    // Text inputs show :focus-visible even after a pointer click. Focus the
    // back button on pointer entry; keyboard entry goes straight to search.
    const target = value ? (pointer ? "back" : "search") : "workspace";
    this.host
      .querySelector<HTMLElement>(".palette-session-settings__" + target)
      ?.focus({ preventScroll: true });
  }

  private keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return;
    }
    // Web Awesome handles dropdown Escape at document level. Let the nested
    // picker close before this settings dialog, without blocking that listener.
    if (
      event
        .composedPath()
        .some((node) => node instanceof Element && node.matches("wa-dropdown[open]"))
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (this.places) {
        void this.showPlaces(false);
      } else {
        this.close();
        this.host
          .querySelector<HTMLElement>("#" + this.id + "-settings-trigger")
          ?.focus({ preventScroll: true });
      }
      return;
    }
    if (
      !["ArrowDown", "ArrowUp"].includes(event.key) ||
      !(event.currentTarget instanceof HTMLElement)
    ) {
      return;
    }
    // The shared agent dropdown owns its own roving focus and keyboard semantics.
    if (
      event.composedPath().some((node) => node instanceof Element && node.tagName === "WA-DROPDOWN")
    ) {
      return;
    }
    const controls = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled)",
      ),
    ];
    const current = controls.findIndex(
      (control) => control === this.host.ownerDocument.activeElement,
    );
    if (!controls.length) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    controls[
      (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length
    ]?.focus();
  }

  view(options: SettingsOptions) {
    const { draft, onChange } = options;
    const { place, gateway, submission } = draft;
    const placementLocked = !gateway.placementPolicyReady || place.requiredPlacement;
    if (placementLocked) {
      this.places = false;
    }
    const locked =
      submission.submitting ||
      Boolean(submission.pendingPlacement.sessionKey) ||
      Boolean(submission.submissionOutcomeUnknown);
    const where = resolveWhereChip({
      hostedEnvironment: place.hostedEnvironment
        ? { ...place.hostedEnvironment, id: place.modelControl.resolveAgentRuntime()!.id }
        : undefined,
      environments: place.canWrite() ? gateway.environments : [],
      cloudProfiles: place.isAdmin() ? gateway.cloudProfiles : [],
      cloudProfileId: place.cloudProfileId,
      ...place.cloudSelection,
      deviceId: place.deviceId,
      autoDevice: place.autoDevice,
      devicePlacement: environmentPlacementRuntime(place.modelControl)?.devicePlacement,
      deviceDisabledReason:
        environmentDeviceDisabledReason(place.modelControl) ?? gateway.deviceCatalogDisabledReason,
    });
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
    const machines: MachineChoice[] = [
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
    const choose = (machine: MachineChoice, projectId?: string) => {
      if (locked || machine.disabledReason) {
        return;
      }
      machine.select();
      if (!machine.hosted && projectId) {
        place.selectProjectId(projectId);
      } else if (!machine.hosted && machine.remote) {
        place.selectNewWorkspace();
      } else if (!machine.hosted) {
        place.applyFolder(place.workspacePath());
      }
      onChange();
      void this.showPlaces(false);
    };
    const query = this.query.trim().toLocaleLowerCase();
    const groups = machines
      .map((machine) => ({
        machine,
        choices: machine.hosted
          ? [{ id: "", label: t("newSession.hostedWorkspace") }].filter(
              (choice) =>
                !query || (machine.label + " " + choice.label).toLocaleLowerCase().includes(query),
            )
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
            ].filter(
              (choice) =>
                !query || (machine.label + " " + choice.label).toLocaleLowerCase().includes(query),
            ),
      }))
      .filter((group) => group.choices.length);
    return {
      options,
      placementLocked,
      locked,
      machineLabel,
      cloudSummary,
      projectState,
      groups,
      id: this.id,
      open: this.open,
      places: this.places,
      query: this.query,
      choose,
      onOpen: () => {
        this.open = true;
        this.host.requestUpdate();
      },
      onHide: () => this.close(),
      onKeydown: (event: KeyboardEvent) => this.keydown(event),
      onShowPlaces: (value: boolean, pointer = false) => void this.showPlaces(value, pointer),
      onQueryInput: (value: string) => {
        this.query = value;
        this.host.requestUpdate();
      },
    };
  }

  render(options: SettingsOptions) {
    return solidContent(PaletteSessionSettingsView, { view: this.view(options) });
  }
}
