import { html, nothing, svg } from "lit";
import { ref } from "lit/directives/ref.js";
import type { ApplicationContext } from "../../app/context.ts";
import { strokeIcon } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import { syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../../lib/keyboard-shortcut-contract.ts";
import type { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import type { NewSessionDraftController } from "./draft-controller.ts";
import type { PaletteSessionPreferences } from "./palette-session-preferences.ts";
import { folderDisplayName } from "./path.ts";
import { resolveProjectChip } from "./project-chip.ts";
import { renderAgentSelect } from "./target-controls.ts";
import { resolveWhereChip } from "./where-chip.ts";
import "../../styles/palette-session-settings.css";

registerNewSessionSetupEnglish();

registerCommandPaletteEnglish();

const settingsIcon = strokeIcon(
  svg`<path d="M4 7h8m4 0h4M4 17h2m4 0h10"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>`,
);

type SettingsOptions = {
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
  selected: boolean;
  disabledReason?: string;
  select: () => void;
};

export class PaletteSessionSettings {
  private open = false;
  private places = false;
  private query = "";

  constructor(
    private readonly host: OpenClawLightDomElement,
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

  render(options: SettingsOptions) {
    const { draft, context, preferences, onChange } = options;
    const { place, gateway, submission } = draft;
    const locked =
      submission.submitting ||
      Boolean(submission.pendingPlacement.sessionKey) ||
      Boolean(submission.submissionOutcomeUnknown);
    const where = resolveWhereChip({
      environments: place.canWrite() ? gateway.environments : [],
      cloudProfiles: place.isAdmin() ? gateway.cloudProfiles : [],
      cloudProfileId: place.cloudProfileId,
      ...place.cloudSelection,
      deviceId: place.deviceId,
      autoDevice: place.autoDevice,
      devicePlacement: place.devicePlacementRuntime()?.devicePlacement,
      deviceDisabledReason:
        place.modelControl.devicePlacementUnsupportedReason() ??
        gateway.deviceCatalogDisabledReason,
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
      {
        id: "local",
        label: gateway.gatewayName || t("newSession.local"),
        remote: false,
        selected: !place.remotePlacement,
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
        disabledReason: place.modelControl.cloudRuntimeUnsupportedReason(profile),
        select: () => place.selectCloudProfile(profile.id),
      })),
    ];
    const choose = (machine: MachineChoice, projectId?: string) => {
      if (locked || machine.disabledReason) {
        return;
      }
      machine.select();
      if (projectId) {
        place.selectProjectId(projectId);
      } else if (machine.remote) {
        place.selectNewWorkspace();
      } else {
        place.applyFolder(place.workspacePath());
      }
      onChange();
      void this.showPlaces(false);
    };
    const query = this.query.trim().toLocaleLowerCase();
    const groups = machines
      .map((machine) => ({
        machine,
        choices: [
          {
            id: "",
            label: machine.remote
              ? t("newSession.newWorkspace")
              : folderDisplayName(place.workspacePath()) || t("newSession.folderPlaceholder"),
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
    return html`
      <button
        id=${this.id + "-settings-trigger"}
        class="palette-session-settings__trigger"
        type="button"
        aria-label=${t("commandPalette.newSessionSettings")}
        title=${t("commandPalette.newSessionSettings")}
        aria-haspopup="dialog"
        aria-expanded=${String(this.open)}
      >
        ${settingsIcon}
      </button>
      <wa-popover
        ${ref(syncPopoverLabel)}
        class="palette-session-settings"
        for=${this.id + "-settings-trigger"}
        placement="bottom-end"
        without-arrow
        .open=${this.open}
        @wa-show=${(event: Event) => {
          if (event.target === event.currentTarget) {
            this.open = true;
            this.host.requestUpdate();
          }
        }}
        @wa-hide=${(event: Event) => {
          if (event.target === event.currentTarget) {
            this.close();
          }
        }}
      >
        <div
          class="palette-session-settings__content"
          @keydown=${(event: KeyboardEvent) => this.keydown(event)}
        >
          ${
            this.places
              ? html`
                  <div class="palette-session-settings__heading">
                    <button
                      type="button"
                      class="palette-session-settings__back"
                      aria-label=${t("common.back")}
                      @click=${() => this.showPlaces(false)}
                    >
                      ${icons.arrowLeft}</button
                    ><span>${t("newSession.projects")}</span>
                  </div>
                  <input
                    class="palette-session-settings__search"
                    type="search"
                    aria-label=${t("common.search")}
                    placeholder=${t("common.search")}
                    .value=${this.query}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        this.query = event.currentTarget.value;
                        this.host.requestUpdate();
                      }
                    }}
                  />
                  <div class="palette-session-settings__choices">
                    ${groups.map(
                      ({ machine, choices }) => html` <section aria-label=${machine.label}>
                        <div class="palette-session-settings__machine">${machine.label}</div>
                        ${choices.map((choice) => html`<button type="button" class="palette-session-settings__row" data-machine=${machine.id} data-project=${choice.id} aria-pressed=${String(machine.selected && (choice.id ? draft.browser.projectId === choice.id : !draft.browser.projectId && (machine.remote ? place.freshWorkspace : place.folder === place.workspacePath())))} title=${machine.disabledReason ?? nothing} ?disabled=${locked || Boolean(machine.disabledReason)} @click=${() => choose(machine, choice.id)}><span class="palette-session-settings__icon">${choice.id ? icons.gitBranch : icons.folder}</span><span class="palette-session-settings__label">${choice.label}</span><span class="palette-session-settings__check">${machine.selected && (choice.id ? draft.browser.projectId === choice.id : !draft.browser.projectId && (machine.remote ? place.freshWorkspace : place.folder === place.workspacePath())) ? icons.check : nothing}</span></button>`)}
                        ${machine.disabledReason ? html`<div class="palette-session-settings__unavailable">${machine.disabledReason}</div>` : nothing}
                      </section>`,
                    )}
                    ${!groups.length ? html`<div class="palette-session-settings__unavailable">${t("newSession.environmentSearchEmpty")}</div>` : nothing}
                    ${gateway.cloudProfilesPending ? html`<div role="status" class="palette-session-settings__unavailable">${t("common.loading")}</div>` : nothing}
                  </div>
                  ${place.isAdmin() ? html`<button class="palette-session-settings__row" type="button" ?disabled=${locked} @click=${options.onConnectMachine}><span class="palette-session-settings__icon">${icons.plus}</span><span>${t("newSession.connectMachine")}</span></button>` : nothing}
                `
              : html`
                  <div class="palette-session-settings__title">
                    ${t("commandPalette.newSessionSettings")}
                  </div>
                  <div class="palette-session-settings__agent">
                    ${renderAgentSelect({
                      agents: place.agents(),
                      variant: "default",
                      agentId: place.agentId,
                      agentIdentity: context?.agentIdentity,
                      disabled: locked,
                      onSelect: (id) => {
                        place.selectAgentId(id);
                        onChange();
                      },
                      onOpenChange: options.onAgentPickerOpen,
                    })}
                  </div>
                  <button
                    class="palette-session-settings__row palette-session-settings__workspace"
                    type="button"
                    ?disabled=${locked}
                    @click=${(event: MouseEvent) => this.showPlaces(true, event.detail > 0)}
                  >
                    <span class="palette-session-settings__icon">${icons.folder}</span
                    ><span class="palette-session-settings__copy"
                      ><span class="palette-session-settings__label">${projectState.label}</span
                      ><span class="palette-session-settings__secondary"
                        >${machineLabel}${cloudSummary ? " · " + cloudSummary : ""}</span
                      ></span
                    ><span class="palette-session-settings__chevron">${icons.chevronRight}</span>
                  </button>
                  <button
                    class="palette-session-settings__row palette-session-settings__worktree"
                    type="button"
                    role="switch"
                    aria-checked=${String(place.worktree)}
                    aria-label=${t("newSession.checkoutWorktree")}
                    title=${place.remotePlacement ? t("newSession.checkoutRemoteLocked") : !place.worktreeAvailable() ? t("newSession.worktreeUnavailable") : nothing}
                    ?disabled=${locked || place.remotePlacement || !place.worktreeAvailable()}
                    @click=${() => {
                      place.selectWorktree(!place.worktree);
                      onChange();
                    }}
                  >
                    <span class="palette-session-settings__icon">${icons.gitBranch}</span
                    ><span>${t("newSession.checkoutWorktree")}</span
                    ><span class="palette-session-settings__switch" aria-hidden="true"></span>
                  </button>
                `
          }
          ${
            !this.places || preferences.failed
              ? html`<div class="palette-session-settings__footer">
                  ${
                    !this.places
                      ? html`<label
                          class="palette-session-settings__remember"
                          title=${!preferences.available ? t("commandPalette.rememberUnavailable") : nothing}
                          ><input
                            type="checkbox"
                            .checked=${preferences.remember}
                            ?disabled=${locked || !preferences.available}
                            @change=${(event: Event) => {
                              if (event.currentTarget instanceof HTMLInputElement) {
                                preferences.setRemember(event.currentTarget.checked);
                              }
                            }}
                          /><span
                            >${t("commandPalette.rememberSettings", { shortcut: formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette) })}</span
                          ></label
                        >`
                      : nothing
                  }
                  ${preferences.failed ? html`<div class="palette-session-settings__error" role="alert">${t("commandPalette.settingsSaveFailed")} <button type="button" class="btn btn--sm" @click=${() => preferences.retry()}>${t("common.retry")}</button></div>` : nothing}
                </div>`
              : nothing
          }
        </div>
      </wa-popover>
    `;
  }
}
