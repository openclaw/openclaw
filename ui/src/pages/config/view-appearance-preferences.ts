import { html, nothing } from "lit";
import {
  BUILTIN_THEMES,
  resolveThemeBranding,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import type { ServerUiPrefProvenance } from "../../app/server-prefs.ts";
import {
  normalizeCatalogOpenTarget,
  normalizeChatMessageMaxWidth,
  normalizeChatFollowUpMode,
  normalizeChatSendShortcut,
  UI_APPEARANCE_DEFAULTS,
} from "../../app/settings.ts";
import { getLobsterdexEntries } from "../../components/lobster-dex.ts";
import { previewLobsterChirp } from "../../components/lobster-pet-audio.ts";
import {
  canonicalLobsterLook,
  lobsterLookStyle,
  renderLobsterSvg,
} from "../../components/lobster-pet-look.ts";
import { LOBSTER_PALETTE_LORE, lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import "../../components/tooltip.ts";
import {
  renderSettingsDefaultDescription,
  renderSettingsRow,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { languageLabel, renderLanguageSelect } from "./language-select.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { renderSessionObserverSettings } from "./session-observer-settings.ts";
import { renderSettingsSectionHeader } from "./settings-section-header.ts";
import { renderSettingsSelectRow } from "./settings-select-row.ts";
import type { ConfigProps } from "./view-types.ts";

export function serverUiPrefProvenanceHint(provenance: ServerUiPrefProvenance): string {
  if (provenance === "profile") {
    return t("configView.profileSyncedHint");
  }
  if (provenance === "device-local") {
    return t("quickSettings.personal.browserOnly");
  }
  if (provenance === "pending") {
    return t("configView.syncPendingHint");
  }
  return t("configView.syncedHint");
}

export function renderLanguageSection(props: ConfigProps) {
  const defaultDescription = renderSettingsDefaultDescription(
    props.localeResetValue ? languageLabel(props.localeResetValue) : t("common.system"),
    props.localeOverridden,
  );
  const provenance = serverUiPrefProvenanceHint(props.localeProvenance);
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.language} class="settings-section">
      ${renderSettingsSectionHeader(t("quickSettings.language"))}
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("quickSettings.language"),
          description: html`${defaultDescription} ${provenance}`,
          control: renderLanguageSelect(
            props.localeOverride,
            props.systemLocale,
            props.onLocaleChange,
          ),
        })}
      </div>
    </section>
  `;
}

function renderSettingsMediaDeviceField(props: ConfigProps, kind: "microphone" | "camera") {
  const state = props[kind];
  const title = t(`chat.composer.${kind}Input`);
  const onSelect = kind === "microphone" ? props.onMicrophoneSelect : props.onCameraSelect;
  const onRefresh = kind === "microphone" ? props.onMicrophoneRefresh : props.onCameraRefresh;
  if (!state || !onSelect) {
    return nothing;
  }
  const selectedDeviceId = state.selectedDeviceId.trim();
  const selectedDeviceKnown = state.devices.some((device) => device.deviceId === selectedDeviceId);
  const selectOptions = [
    {
      label: t(
        kind === "microphone"
          ? "chat.composer.systemDefaultMicrophone"
          : "chat.composer.systemDefaultCamera",
      ),
      value: "",
    },
    ...state.devices.map((device) => ({ label: device.label, value: device.deviceId })),
    // A remembered device that is unplugged right now stays selectable so the
    // choice survives until the user picks something else.
    ...(selectedDeviceId && !selectedDeviceKnown
      ? [
          {
            label: t(`chat.composer.${kind}Fallback`, { number: String(state.devices.length + 1) }),
            value: selectedDeviceId,
          },
        ]
      : []),
  ];
  let accessRequested = false;
  const requestAccess = () => {
    if (accessRequested || !state.permissionRequired) {
      return;
    }
    accessRequested = true;
    onRefresh?.();
  };
  const requestAccessFromPointer = (event: PointerEvent) => {
    if (event.button === 0) {
      requestAccess();
    }
  };
  const requestAccessFromKeyboard = (event: KeyboardEvent) => {
    if (["Enter", " ", "ArrowDown", "ArrowUp", "F4"].includes(event.key)) {
      requestAccess();
    }
  };
  const note = state.error
    ? html`<span role="alert">${state.error}</span>`
    : !state.loading && state.devices.length === 0
      ? t(kind === "microphone" ? "chat.composer.noMicrophones" : "chat.composer.noCameras")
      : undefined;
  return renderSettingsRow({
    title,
    description: html`${note ? html`${note}<br />` : nothing}${t(
      "quickSettings.personal.browserOnly",
    )}`,
    control: html`
      <select
        class="settings-select settings-select--media-device"
        data-settings-microphone=${kind === "microphone" ? "" : nothing}
        data-settings-camera=${kind === "camera" ? "" : nothing}
        aria-label=${title}
        .value=${selectedDeviceId}
        @pointerdown=${requestAccessFromPointer}
        @keydown=${requestAccessFromKeyboard}
        @change=${(event: Event) => onSelect((event.currentTarget as HTMLSelectElement).value)}
      >
        ${selectOptions.map(
          (option) => html`
            <option value=${option.value} ?selected=${option.value === selectedDeviceId}>
              ${option.label}
            </option>
          `,
        )}
      </select>
    `,
  });
}

export function renderChatPreferencesSection(props: ConfigProps) {
  const followUpSelection = props.chatFollowUpMode ?? "server";
  const serverQueueMode = props.serverQueueMode ?? t("chat.followUpModeLoading");
  const followUpDescription = props.chatFollowUpMode
    ? t("chat.followUpModeOverriding", { mode: serverQueueMode })
    : nothing;
  const messageWidthDefaultDescription = renderSettingsDefaultDescription(
    UI_APPEARANCE_DEFAULTS.chatMessageMaxWidth,
    props.chatMessageMaxWidth !== undefined,
  );
  const sendShortcutDefaultDescription = renderSettingsDefaultDescription(
    props.chatSendShortcutResetValue === "modifier-enter"
      ? t("chat.sendShortcutModifierEnter")
      : t("chat.sendShortcutEnter"),
    props.chatSendShortcutOverridden,
  );
  const sendShortcutProvenance = serverUiPrefProvenanceHint(props.chatSendShortcutProvenance);
  const followUpProvenance = serverUiPrefProvenanceHint(props.chatFollowUpModeProvenance);
  const catalogTargetDefaultDescription = renderSettingsDefaultDescription(
    t("chat.catalogOpenTargetViewer"),
    props.catalogOpenTarget !== UI_APPEARANCE_DEFAULTS.catalogOpenTarget,
  );
  const holdToRecordDefaultDescription = renderSettingsDefaultDescription(
    t("common.enabled"),
    props.composerHoldToRecord !== UI_APPEARANCE_DEFAULTS.composerHoldToRecord,
  );
  const showTaskProgressDefaultDescription = renderSettingsDefaultDescription(
    t("common.enabled"),
    props.chatShowTaskProgress !== UI_APPEARANCE_DEFAULTS.chatShowTaskProgress,
  );
  const collapseTaskProgressDefaultDescription = renderSettingsDefaultDescription(
    t("common.disabled"),
    props.chatCollapseTaskProgress !== UI_APPEARANCE_DEFAULTS.chatCollapseTaskProgress,
  );
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.chat} class="settings-section">
      ${renderSettingsSectionHeader(t("configView.chatPrefs.title"))}
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.chatPrefs.messageWidth"),
          description: html`${t("configView.chatPrefs.messageWidthHint")}<br />
            ${messageWidthDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          control: html`
            <input
              class="settings-input"
              data-settings-chat-message-width
              aria-label=${t("configView.chatPrefs.messageWidth")}
              type="text"
              spellcheck="false"
              placeholder="48rem"
              .value=${props.chatMessageMaxWidth ?? ""}
              @change=${(event: Event) => {
                // SAFETY: The listener is bound directly to this input.
                const input = event.currentTarget as HTMLInputElement;
                const normalized = normalizeChatMessageMaxWidth(input.value);
                if (input.value.trim() && !normalized) {
                  input.setCustomValidity(t("configView.chatPrefs.messageWidthInvalid"));
                  input.reportValidity();
                  return;
                }
                input.setCustomValidity("");
                input.value = normalized ?? "";
                props.onAppearanceChange({ chatMessageMaxWidth: normalized });
              }}
            />
          `,
        })}
        ${renderSettingsToggleRow({
          title: t("configView.chatPrefs.showTaskProgress"),
          description: html`${t("configView.chatPrefs.showTaskProgressHint")}<br />
            ${showTaskProgressDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: props.chatShowTaskProgress,
          onChange: (enabled) => props.onAppearanceChange({ chatShowTaskProgress: enabled }),
        })}
        ${renderSettingsToggleRow({
          title: t("configView.chatPrefs.collapseTaskProgress"),
          description: html`${t("configView.chatPrefs.collapseTaskProgressHint")}<br />
            ${collapseTaskProgressDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: props.chatCollapseTaskProgress,
          onChange: (enabled) => props.onAppearanceChange({ chatCollapseTaskProgress: enabled }),
          disabled: !props.chatShowTaskProgress,
        })}
        ${renderSettingsSelectRow({
          title: t("chat.sendShortcut"),
          value: props.chatSendShortcut,
          setting: "send-shortcut",
          description: html`${sendShortcutDefaultDescription} ${sendShortcutProvenance}`,
          options: [
            { value: "enter", label: t("chat.sendShortcutEnter") },
            { value: "modifier-enter", label: t("chat.sendShortcutModifierEnter") },
          ],
          onChange: (value) =>
            props.onAppearanceChange({ chatSendShortcut: normalizeChatSendShortcut(value) }),
        })}
        ${renderSettingsRow({
          title: t("chat.followUpMode"),
          description: html`${followUpDescription} ${followUpProvenance}`,
          control: html`
            <select
              class="settings-select"
              data-settings-follow-up-mode
              aria-label=${t("chat.followUpMode")}
              .value=${followUpSelection}
              @change=${(event: Event) => {
                const value = (event.currentTarget as HTMLSelectElement).value;
                props.onAppearanceChange({
                  chatFollowUpMode:
                    value === "server" ? undefined : normalizeChatFollowUpMode(value),
                });
              }}
            >
              <option value="server" ?selected=${followUpSelection === "server"}>
                ${t("chat.followUpModeServer", { mode: serverQueueMode })}
              </option>
              <option value="steer" ?selected=${followUpSelection === "steer"}>
                ${t("chat.followUpModeSteer")}
              </option>
              <option value="queue" ?selected=${followUpSelection === "queue"}>
                ${t("chat.followUpModeQueue")}
              </option>
            </select>
            ${
              props.chatFollowUpModeOverridden
                ? html`<button
                    type="button"
                    class="btn btn--sm"
                    @click=${props.resetChatFollowUpMode}
                  >
                    ${t("chat.followUpModeReset")}
                  </button>`
                : nothing
            }
          `,
        })}
        ${renderSettingsSelectRow({
          title: t("chat.catalogOpenTarget"),
          value: props.catalogOpenTarget,
          setting: "catalog-open-target",
          description: html`${catalogTargetDefaultDescription}
          ${t("quickSettings.personal.browserOnly")}`,
          options: [
            { value: "viewer", label: t("chat.catalogOpenTargetViewer") },
            { value: "terminal", label: t("chat.catalogOpenTargetTerminal") },
          ],
          onChange: (value) =>
            props.onAppearanceChange({ catalogOpenTarget: normalizeCatalogOpenTarget(value) }),
        })}
        ${renderSettingsToggleRow({
          title: t("configView.chatPrefs.openLinksExternally"),
          description: html`${t("configView.chatPrefs.openLinksExternallyHint")}<br />
            ${t("configView.chatPrefs.openLinksExternallyStorage")}`,
          checked: props.openLinksExternally,
          onChange: (enabled) => props.onAppearanceChange({ openLinksExternally: enabled }),
        })}
        ${renderSettingsMediaDeviceField(props, "microphone")}
        ${renderSettingsMediaDeviceField(props, "camera")}
        ${renderSettingsToggleRow({
          title: t("chat.composer.holdToRecordSetting"),
          description: html`${t("chat.composer.holdToRecordSettingDescription")}<br />
            ${holdToRecordDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: props.composerHoldToRecord,
          onChange: (enabled) => props.onAppearanceChange({ composerHoldToRecord: enabled }),
        })}
      </div>
    </section>
  `;
}

export function renderLobsterPetSection(props: ConfigProps) {
  const { lobsterPetVisits, lobsterPetSounds } = props;
  const activeTheme =
    BUILTIN_THEMES.find((theme) => theme.id === props.theme) ??
    props.themeCatalog?.themes.find((theme) => theme.id === props.theme);
  const themeHiddenDescription =
    resolveThemeBranding(activeTheme).mascot === "none"
      ? html`<br />${t("quickSettings.appearance.lobsterVisitsThemeHidden", {
            theme:
              activeTheme?.source === "builtin"
                ? t(`configView.themes.${activeTheme.id}.label`)
                : (activeTheme?.name ?? props.theme),
          })}`
      : nothing;
  const lobsterVisitsDefaultDescription = renderSettingsDefaultDescription(
    t("common.enabled"),
    lobsterPetVisits !== UI_APPEARANCE_DEFAULTS.lobsterPetVisits,
  );
  const lobsterSoundsDefaultDescription = renderSettingsDefaultDescription(
    t("common.disabled"),
    lobsterPetSounds !== UI_APPEARANCE_DEFAULTS.lobsterPetSounds,
  );
  const dexEntries = getLobsterdexEntries();
  const seenCount = LOBSTER_PET_PALETTES.filter((palette) => dexEntries.has(palette.id)).length;
  return html`
    <section class="settings-section">
      ${renderSettingsSectionHeader(t("quickSettings.appearance.lobsterdex"))}
      <div class="settings-group">
        ${renderSettingsToggleRow({
          title: t("quickSettings.appearance.lobsterVisits"),
          description: html`${t(
              lobsterPetVisits
                ? "quickSettings.appearance.lobsterVisitsOn"
                : "quickSettings.appearance.lobsterVisitsOff",
            )}<br />
            ${lobsterVisitsDefaultDescription}
            ${t("quickSettings.personal.browserOnly")}${themeHiddenDescription}`,
          checked: lobsterPetVisits,
          onChange: (enabled) => props.onAppearanceChange({ lobsterPetVisits: enabled }),
        })}
        ${renderSettingsToggleRow({
          title: t("quickSettings.appearance.lobsterSounds"),
          description: html`${t(
              lobsterPetSounds
                ? "quickSettings.appearance.lobsterSoundsOn"
                : "quickSettings.appearance.lobsterSoundsOff",
            )}<br />
            ${lobsterSoundsDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: lobsterPetSounds,
          onChange: (enabled) => props.onAppearanceChange({ lobsterPetSounds: enabled }),
          onAct: (enabled) => {
            if (enabled) {
              previewLobsterChirp();
            }
          },
        })}
        ${renderSettingsRow({
          title: t("quickSettings.appearance.lobsterdex"),
          description: t("quickSettings.appearance.lobsterdexSeen", {
            seen: String(seenCount),
            total: String(LOBSTER_PET_PALETTES.length),
          }),
          stacked: true,
          control: html`
            <div class="lobsterdex__gallery">
              <div class="lobsterdex">
                ${LOBSTER_PET_PALETTES.map((palette) => {
                  const look = canonicalLobsterLook(palette);
                  const entry = dexEntries.get(palette.id);
                  const seen = entry !== undefined;
                  const shinySeen = entry?.shinySeenAt != null;
                  const baseName = seen ? (entry.name ?? lobsterPaletteName(palette.id)) : "?";
                  const displayName = shinySeen ? `${baseName} ✦` : baseName;
                  const lore = LOBSTER_PALETTE_LORE[palette.id];
                  const loreLine = seen ? lore.flavor : lore.hint;
                  const visitedLine =
                    seen && entry.firstSeenAt !== null
                      ? t("quickSettings.appearance.lobsterdexFirstVisited", {
                          name: baseName,
                          date: new Date(entry.firstSeenAt).toLocaleDateString(),
                        })
                      : null;
                  const ariaLabel = [displayName, loreLine, visitedLine]
                    .filter((line): line is string => line !== null)
                    .join("\n");
                  return html`
                    <openclaw-tooltip>
                      <span
                        class="lobsterdex__mini lobster-pet--palette-${palette.id} ${
                          seen ? "" : "lobsterdex__mini--unseen"
                        }"
                        style=${lobsterLookStyle(look)}
                        tabindex="0"
                        role="img"
                        aria-label=${ariaLabel}
                      >
                        ${renderLobsterSvg(look, { standalone: true })}
                        ${
                          shinySeen
                            ? html`<span class="lobsterdex__mini-star" aria-hidden="true">✦</span>`
                            : nothing
                        }
                      </span>
                      <span slot="content" class="lobsterdex__tooltip">
                        <strong>${displayName}</strong>
                        <span>${loreLine}</span>
                        ${visitedLine ? html`<span>${visitedLine}</span>` : nothing}
                      </span>
                    </openclaw-tooltip>
                  `;
                })}
              </div>
              ${
                props.lobsterdexHref
                  ? html`<a
                      class="btn btn--sm lobsterdex__open"
                      href=${props.lobsterdexHref}
                      @click=${(event: MouseEvent) => {
                        if (!shouldHandleNavigationClick(event)) {
                          return;
                        }
                        event.preventDefault();
                        props.onOpenLobsterdex?.();
                      }}
                      >${t("quickSettings.appearance.lobsterdexOpen")}</a
                    >`
                  : nothing
              }
            </div>
          `,
        })}
      </div>
    </section>
  `;
}

export function renderSidebarPreferencesSection(props: ConfigProps) {
  const hiddenCatalogIds = [...props.hiddenSessionCatalogIds].toSorted();
  const liveActivityDefaultDescription = renderSettingsDefaultDescription(
    t("common.enabled"),
    props.sidebarLiveActivity !== UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
  );
  // The delete dialog's "Don't ask me again" writes this off; this row is where
  // the operator turns it back on, so it has to stay next to the session prefs.
  const sessionDeleteConfirm = props.sessionDeleteConfirm;
  const deleteConfirmDefaultDescription = renderSettingsDefaultDescription(
    t("common.enabled"),
    sessionDeleteConfirm !== UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm,
  );
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.sidebar} class="settings-section">
      ${renderSettingsSectionHeader(t("configView.sidebarPrefs.title"))}
      <p class="settings-section__desc">${t("configView.sidebarPrefs.hint")}</p>
      <div class="settings-group">
        ${renderSettingsToggleRow({
          title: t("configView.sidebarPrefs.liveActivity"),
          description: html`${t("configView.sidebarPrefs.liveActivityHint")}<br />
            ${liveActivityDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: props.sidebarLiveActivity,
          onChange: (enabled) => props.onAppearanceChange({ sidebarLiveActivity: enabled }),
        })}
        ${renderSettingsToggleRow({
          title: t("configView.sidebarPrefs.deleteConfirm"),
          description: html`${t("configView.sidebarPrefs.deleteConfirmHint")}<br />
            ${deleteConfirmDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: sessionDeleteConfirm,
          onChange: (enabled) => props.onAppearanceChange({ sessionDeleteConfirm: enabled }),
        })}
      </div>
      ${
        hiddenCatalogIds.length > 0
          ? html`
              <div class="settings-section__header settings-section__header--subsection">
                <h3 class="settings-section__heading">
                  ${t("chat.sidebar.hiddenSessionSections")}
                </h3>
              </div>
              <div class="settings-group">
                ${hiddenCatalogIds.map((catalogId) =>
                  renderSettingsRow({
                    title: props.hiddenSessionCatalogLabels.get(catalogId) ?? catalogId,
                    description: t("quickSettings.personal.browserOnly"),
                    control: html`<button
                      type="button"
                      class="btn btn--sm"
                      @click=${() => props.setSessionCatalogHidden(catalogId, false)}
                    >
                      ${t("chat.sidebar.showSessionSection")}
                    </button>`,
                  }),
                )}
              </div>
            `
          : nothing
      }
      <div class="settings-section__header settings-section__header--subsection">
        <h3 class="settings-section__heading">${t("configView.sessionObserver.title")}</h3>
      </div>
      <p class="settings-section__desc">${t("configView.sessionObserver.hint")}</p>
      ${renderSessionObserverSettings({
        enabled: props.sessionObserverEnabled !== false,
        utilityModel: props.sessionObserverUtilityModel,
        resolvedUtilityModel: props.sessionObserverResolvedModel,
        models: props.sessionObserverModels ?? [],
        modelsUnavailable: props.sessionObserverModelsUnavailable === true,
        disabled: props.sessionObserverDisabled === true,
        onEnabledChange: (enabled) => props.setSessionObserverEnabled?.(enabled),
        onUtilityModelChange: (selection) => props.setSessionObserverUtilityModel?.(selection),
      })}
    </section>
  `;
}
