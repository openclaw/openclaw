import { createEffect, createMemo, Show, For } from "solid-js";
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
import { previewLobsterChirp } from "../../components/lobster-pet-audio.ts";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-look.ts";
import { LOBSTER_PALETTE_LORE, lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import {
  renderSettingsDefaultDescription,
  SettingsRow,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import "../../components/tooltip.ts";
import "../../components/lobster-illustration.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { projectLobsterdex } from "../../lib/reactive/events-browser.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { languageLabel, LanguageSelect } from "./language-select.tsx";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { SessionObserverSettings } from "./session-observer-settings.tsx";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
import { SettingsSelectRow } from "./settings-select-row.tsx";
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
export function LanguageSection(props: ConfigProps) {
  const defaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      props.localeResetValue ? languageLabel(props.localeResetValue) : t("common.system"),
      props.localeOverridden,
    ),
  );
  const provenance = createMemo(() => serverUiPrefProvenanceHint(props.localeProvenance));
  return (
    <>
      <section id={APPEARANCE_SETTINGS_TARGET_IDS.language} class="settings-section">
        {<SettingsSectionHeader title={t("quickSettings.language")} />}
        <div class="settings-group">
          {
            <SettingsRow
              title={t("quickSettings.language")}
              description={
                <>
                  {defaultDescription()} {provenance()}
                </>
              }
              control={
                <LanguageSelect
                  localeOverride={props.localeOverride}
                  systemLocale={props.systemLocale}
                  onLocaleChange={props.onLocaleChange}
                />
              }
            />
          }
        </div>
      </section>
    </>
  );
}
function MediaDeviceField(props: { config: ConfigProps; kind: "microphone" | "camera" }) {
  const state = createMemo(() => props.config[props.kind]);
  const title = createMemo(() => t(`chat.composer.${props.kind}Input`));
  const onSelect = createMemo(() =>
    props.kind === "microphone" ? props.config.onMicrophoneSelect : props.config.onCameraSelect,
  );
  const selectedDeviceId = createMemo(() => state()?.selectedDeviceId.trim() ?? "");
  const selectOptions = createMemo(() => {
    const devices = state()?.devices ?? [];
    return [
      {
        label: t(
          props.kind === "microphone"
            ? "chat.composer.systemDefaultMicrophone"
            : "chat.composer.systemDefaultCamera",
        ),
        value: "",
      },
      ...devices.map((device) => ({
        label: device.label,
        value: device.deviceId,
      })),
      // Preserve a selected unplugged device until the operator chooses another.
      ...(selectedDeviceId() && !devices.some((device) => device.deviceId === selectedDeviceId())
        ? [
            {
              label: t(`chat.composer.${props.kind}Fallback`, {
                number: String(devices.length + 1),
              }),
              value: selectedDeviceId(),
            },
          ]
        : []),
    ];
  });
  let accessRequested = false;
  createEffect(
    () => state(),
    () => {
      accessRequested = false;
    },
  );
  const requestAccess = () => {
    if (accessRequested || !state()?.permissionRequired) {
      return;
    }
    accessRequested = true;
    (props.kind === "microphone"
      ? props.config.onMicrophoneRefresh
      : props.config.onCameraRefresh)?.();
  };
  const note = createMemo(() =>
    state()?.error ? (
      <span role="alert">{state()?.error}</span>
    ) : !state()?.loading && state()?.devices.length === 0 ? (
      t(props.kind === "microphone" ? "chat.composer.noMicrophones" : "chat.composer.noCameras")
    ) : undefined,
  );
  return (
    <Show when={state() && onSelect()}>
      <SettingsRow
        title={title()}
        description={
          <>
            {note() ? (
              <>
                {note()}
                <br />
              </>
            ) : undefined}
            {t("quickSettings.personal.browserOnly")}
          </>
        }
        control={
          <select
            class="settings-select settings-select--media-device"
            data-settings-microphone={props.kind === "microphone" ? "" : undefined}
            data-settings-camera={props.kind === "camera" ? "" : undefined}
            aria-label={title()}
            prop:value={selectedDeviceId()}
            onPointerDown={(event) => {
              if (event.button === 0) {
                requestAccess();
              }
            }}
            onKeyDown={(event) => {
              if (["Enter", " ", "ArrowDown", "ArrowUp", "F4"].includes(event.key)) {
                requestAccess();
              }
            }}
            onChange={(event) => onSelect()?.(event.currentTarget.value)}
          >
            {
              <For each={selectOptions()}>
                {(option) => (
                  <option value={option.value} selected={option.value === selectedDeviceId()}>
                    {option.label}
                  </option>
                )}
              </For>
            }
          </select>
        }
      />
    </Show>
  );
}
export function ChatPreferencesSection(props: ConfigProps) {
  const followUpSelection = createMemo(() => props.chatFollowUpMode ?? "server");
  const serverQueueMode = createMemo(() => props.serverQueueMode ?? t("chat.followUpModeLoading"));
  const followUpDescription = createMemo(() =>
    props.chatFollowUpMode
      ? t("chat.followUpModeOverriding", {
          mode: serverQueueMode(),
        })
      : undefined,
  );
  const messageWidthDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      UI_APPEARANCE_DEFAULTS.chatMessageMaxWidth,
      props.chatMessageMaxWidth !== undefined,
    ),
  );
  const sendShortcutDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      props.chatSendShortcutResetValue === "modifier-enter"
        ? t("chat.sendShortcutModifierEnter")
        : t("chat.sendShortcutEnter"),
      props.chatSendShortcutOverridden,
    ),
  );
  const sendShortcutProvenance = createMemo(() =>
    serverUiPrefProvenanceHint(props.chatSendShortcutProvenance),
  );
  const followUpProvenance = createMemo(() =>
    serverUiPrefProvenanceHint(props.chatFollowUpModeProvenance),
  );
  const catalogTargetDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      t("chat.catalogOpenTargetViewer"),
      props.catalogOpenTarget !== UI_APPEARANCE_DEFAULTS.catalogOpenTarget,
    ),
  );
  const holdToRecordDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      t("common.enabled"),
      props.composerHoldToRecord !== UI_APPEARANCE_DEFAULTS.composerHoldToRecord,
    ),
  );
  const showTaskProgressDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      t("common.enabled"),
      props.chatShowTaskProgress !== UI_APPEARANCE_DEFAULTS.chatShowTaskProgress,
    ),
  );
  const collapseTaskProgressDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      t("common.disabled"),
      props.chatCollapseTaskProgress !== UI_APPEARANCE_DEFAULTS.chatCollapseTaskProgress,
    ),
  );
  return (
    <>
      <section id={APPEARANCE_SETTINGS_TARGET_IDS.chat} class="settings-section">
        {<SettingsSectionHeader title={t("configView.chatPrefs.title")} />}
        <div class="settings-group">
          {
            <SettingsRow
              title={t("configView.chatPrefs.messageWidth")}
              description={
                <>
                  {t("configView.chatPrefs.messageWidthHint")}
                  <br />
                  {messageWidthDefaultDescription()} {t("quickSettings.personal.browserOnly")}
                </>
              }
              control={
                <>
                  <input
                    class="settings-input"
                    data-settings-chat-message-width
                    aria-label={t("configView.chatPrefs.messageWidth")}
                    type="text"
                    spellCheck="false"
                    placeholder="48rem"
                    prop:value={props.chatMessageMaxWidth ?? ""}
                    onChange={(event: Event) => {
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
                      props.onAppearanceChange({
                        chatMessageMaxWidth: normalized,
                      });
                    }}
                  />
                </>
              }
            />
          }
          {
            <SettingsToggleRow
              title={t("configView.chatPrefs.showTaskProgress")}
              description={
                <>
                  {t("configView.chatPrefs.showTaskProgressHint")}
                  <br />
                  {showTaskProgressDefaultDescription()} {t("quickSettings.personal.browserOnly")}
                </>
              }
              checked={props.chatShowTaskProgress}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  chatShowTaskProgress: enabled,
                })
              }
            />
          }
          {
            <SettingsToggleRow
              title={t("configView.chatPrefs.collapseTaskProgress")}
              description={
                <>
                  {t("configView.chatPrefs.collapseTaskProgressHint")}
                  <br />
                  {collapseTaskProgressDefaultDescription()}{" "}
                  {t("quickSettings.personal.browserOnly")}
                </>
              }
              checked={props.chatCollapseTaskProgress}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  chatCollapseTaskProgress: enabled,
                })
              }
              disabled={!props.chatShowTaskProgress}
            />
          }
          {
            <SettingsSelectRow
              title={t("chat.sendShortcut")}
              value={props.chatSendShortcut}
              setting={"send-shortcut"}
              description={
                <>
                  {sendShortcutDefaultDescription()} {sendShortcutProvenance()}
                </>
              }
              options={[
                {
                  value: "enter",
                  label: t("chat.sendShortcutEnter"),
                },
                {
                  value: "modifier-enter",
                  label: t("chat.sendShortcutModifierEnter"),
                },
              ]}
              onChange={(value) =>
                props.onAppearanceChange({
                  chatSendShortcut: normalizeChatSendShortcut(value),
                })
              }
            />
          }
          {
            <SettingsRow
              title={t("chat.followUpMode")}
              description={
                <>
                  {followUpDescription()} {followUpProvenance()}
                </>
              }
              control={
                <>
                  <select
                    class="settings-select"
                    data-settings-follow-up-mode
                    aria-label={t("chat.followUpMode")}
                    prop:value={followUpSelection()}
                    onChange={(event: Event) => {
                      const value = (event.currentTarget as HTMLSelectElement).value;
                      props.onAppearanceChange({
                        chatFollowUpMode:
                          value === "server" ? undefined : normalizeChatFollowUpMode(value),
                      });
                    }}
                  >
                    <option value="server" selected={followUpSelection() === "server"}>
                      {t("chat.followUpModeServer", {
                        mode: serverQueueMode(),
                      })}
                    </option>
                    <option value="steer" selected={followUpSelection() === "steer"}>
                      {t("chat.followUpModeSteer")}
                    </option>
                    <option value="queue" selected={followUpSelection() === "queue"}>
                      {t("chat.followUpModeQueue")}
                    </option>
                  </select>
                  {props.chatFollowUpModeOverridden ? (
                    <>
                      <button
                        type="button"
                        class="btn btn--sm"
                        onClick={() => props.resetChatFollowUpMode()}
                      >
                        {t("chat.followUpModeReset")}
                      </button>
                    </>
                  ) : undefined}
                </>
              }
            />
          }
          {
            <SettingsSelectRow
              title={t("chat.catalogOpenTarget")}
              value={props.catalogOpenTarget}
              setting={"catalog-open-target"}
              description={
                <>
                  {catalogTargetDefaultDescription()}
                  {t("quickSettings.personal.browserOnly")}
                </>
              }
              options={[
                {
                  value: "viewer",
                  label: t("chat.catalogOpenTargetViewer"),
                },
                {
                  value: "terminal",
                  label: t("chat.catalogOpenTargetTerminal"),
                },
              ]}
              onChange={(value) =>
                props.onAppearanceChange({
                  catalogOpenTarget: normalizeCatalogOpenTarget(value),
                })
              }
            />
          }
          {
            <SettingsToggleRow
              title={t("configView.chatPrefs.openLinksExternally")}
              description={
                <>
                  {t("configView.chatPrefs.openLinksExternallyHint")}
                  <br />
                  {t("configView.chatPrefs.openLinksExternallyStorage")}
                </>
              }
              checked={props.openLinksExternally}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  openLinksExternally: enabled,
                })
              }
            />
          }
          {<MediaDeviceField config={props} kind="microphone" />}
          {<MediaDeviceField config={props} kind="camera" />}
          {
            <SettingsToggleRow
              title={t("chat.composer.holdToRecordSetting")}
              description={
                <>
                  {t("chat.composer.holdToRecordSettingDescription")}
                  <br />
                  {holdToRecordDefaultDescription()} {t("quickSettings.personal.browserOnly")}
                </>
              }
              checked={props.composerHoldToRecord}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  composerHoldToRecord: enabled,
                })
              }
            />
          }
        </div>
      </section>
    </>
  );
}
export function LobsterPetSection(props: ConfigProps) {
  const activeTheme = createMemo(
    () =>
      BUILTIN_THEMES.find((theme) => theme.id === props.theme) ??
      props.themeCatalog?.themes.find((theme) => theme.id === props.theme),
  );
  const branding = createMemo(() => resolveThemeBranding(activeTheme()));
  const themeHiddenDescription = createMemo(() =>
    branding().mascot === "none" ? (
      <>
        <br />
        {t("quickSettings.appearance.lobsterVisitsThemeHidden", {
          theme:
            activeTheme()?.source === "builtin"
              ? t(`configView.themes.${activeTheme()?.id}.label`)
              : (activeTheme()?.name ?? props.theme),
        })}
      </>
    ) : undefined,
  );
  const lobsterVisitsDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      t("common.enabled"),
      props.lobsterPetVisits !== UI_APPEARANCE_DEFAULTS.lobsterPetVisits,
    ),
  );
  const lobsterSoundsDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      t("common.disabled"),
      props.lobsterPetSounds !== UI_APPEARANCE_DEFAULTS.lobsterPetSounds,
    ),
  );
  const dex = projectLobsterdex();
  const dexEntries = () => dex.read();
  const seenCount = createMemo(
    () => LOBSTER_PET_PALETTES.filter((palette) => dexEntries().has(palette.id)).length,
  );
  return (
    <Show when={branding().lobsterdex}>
      <section class="settings-section">
        {<SettingsSectionHeader title={t("quickSettings.appearance.lobsterdex")} />}
        <div class="settings-group">
          {
            <SettingsToggleRow
              title={t("quickSettings.appearance.lobsterVisits")}
              description={
                <>
                  {t(
                    props.lobsterPetVisits
                      ? "quickSettings.appearance.lobsterVisitsOn"
                      : "quickSettings.appearance.lobsterVisitsOff",
                  )}
                  <br />
                  {lobsterVisitsDefaultDescription()}
                  {t("quickSettings.personal.browserOnly")}
                  {themeHiddenDescription()}
                </>
              }
              checked={props.lobsterPetVisits}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  lobsterPetVisits: enabled,
                })
              }
            />
          }
          {
            <SettingsToggleRow
              title={t("quickSettings.appearance.lobsterSounds")}
              description={
                <>
                  {t(
                    props.lobsterPetSounds
                      ? "quickSettings.appearance.lobsterSoundsOn"
                      : "quickSettings.appearance.lobsterSoundsOff",
                  )}
                  <br />
                  {lobsterSoundsDefaultDescription()} {t("quickSettings.personal.browserOnly")}
                </>
              }
              checked={props.lobsterPetSounds}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  lobsterPetSounds: enabled,
                })
              }
              onAct={(enabled) => {
                if (enabled) {
                  previewLobsterChirp();
                }
              }}
            />
          }
          {
            <SettingsRow
              title={t("quickSettings.appearance.lobsterdex")}
              description={t("quickSettings.appearance.lobsterdexSeen", {
                seen: String(seenCount()),
                total: String(LOBSTER_PET_PALETTES.length),
              })}
              stacked={true}
              control={
                <>
                  <div class="lobsterdex__gallery">
                    <div class="lobsterdex">
                      {
                        <For each={LOBSTER_PET_PALETTES}>
                          {(palette) => {
                            const look = canonicalLobsterLook(palette);
                            const entry = createMemo(() => dexEntries().get(palette.id));
                            const seen = createMemo(() => entry() !== undefined);
                            const shinySeen = createMemo(() => entry()?.shinySeenAt != null);
                            const baseName = createMemo(() =>
                              entry() ? (entry()?.name ?? lobsterPaletteName(palette.id)) : "?",
                            );
                            const displayName = createMemo(() =>
                              shinySeen() ? `${baseName()} ✦` : baseName(),
                            );
                            const lore = LOBSTER_PALETTE_LORE[palette.id];
                            const loreLine = createMemo(() => (seen() ? lore.flavor : lore.hint));
                            const visitedLine = createMemo(() => {
                              const firstSeenAt = entry()?.firstSeenAt;
                              return firstSeenAt != null
                                ? t("quickSettings.appearance.lobsterdexFirstVisited", {
                                    name: baseName(),
                                    date: new Date(firstSeenAt).toLocaleDateString(),
                                  })
                                : null;
                            });
                            const ariaLabel = createMemo(() =>
                              [displayName(), loreLine(), visitedLine()]
                                .filter((line): line is string => line !== null)
                                .join("\n"),
                            );
                            return (
                              <>
                                <openclaw-tooltip>
                                  <span
                                    class={[
                                      "lobsterdex__mini",
                                      `lobster-pet--palette-${palette.id}`,
                                      { "lobsterdex__mini--unseen": !seen() },
                                    ]}
                                    style={lobsterLookStyle(look)}
                                    tabIndex={0}
                                    role="img"
                                    aria-label={ariaLabel()}
                                  >
                                    <openclaw-lobster-illustration
                                      style={{ display: "contents" }}
                                      prop:look={look}
                                      prop:options={{
                                        standalone: true,
                                      }}
                                    />
                                    {shinySeen() ? (
                                      <>
                                        <span class="lobsterdex__mini-star" aria-hidden="true">
                                          ✦
                                        </span>
                                      </>
                                    ) : undefined}
                                  </span>
                                  <span slot="content" class="lobsterdex__tooltip">
                                    <strong>{displayName()}</strong>
                                    <span>{loreLine()}</span>
                                    {visitedLine() ? (
                                      <>
                                        <span>{visitedLine()}</span>
                                      </>
                                    ) : undefined}
                                  </span>
                                </openclaw-tooltip>
                              </>
                            );
                          }}
                        </For>
                      }
                    </div>
                    {props.lobsterdexHref ? (
                      <>
                        <a
                          class="btn btn--sm lobsterdex__open"
                          href={props.lobsterdexHref}
                          onClick={(event: MouseEvent) => {
                            if (!shouldHandleNavigationClick(event)) {
                              return;
                            }
                            event.preventDefault();
                            props.onOpenLobsterdex?.();
                          }}
                        >
                          {t("quickSettings.appearance.lobsterdexOpen")}
                        </a>
                      </>
                    ) : undefined}
                  </div>
                </>
              }
            />
          }
        </div>
      </section>
    </Show>
  );
}
export function SidebarPreferencesSection(props: ConfigProps) {
  const hiddenCatalogIds = createMemo(() => [...props.hiddenSessionCatalogIds].toSorted());
  const liveActivityDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      t("common.enabled"),
      props.sidebarLiveActivity !== UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
    ),
  );
  // The delete dialog's "Don't ask me again" writes this off; this row is where
  // the operator turns it back on, so it has to stay next to the session prefs.
  const sessionDeleteConfirm = createMemo(() => props.sessionDeleteConfirm);
  const deleteConfirmDefaultDescription = createMemo(() =>
    renderSettingsDefaultDescription(
      t("common.enabled"),
      sessionDeleteConfirm() !== UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm,
    ),
  );
  return (
    <>
      <section id={APPEARANCE_SETTINGS_TARGET_IDS.sidebar} class="settings-section">
        {<SettingsSectionHeader title={t("configView.sidebarPrefs.title")} />}
        <p class="settings-section__desc">{t("configView.sidebarPrefs.hint")}</p>
        <div class="settings-group">
          {
            <SettingsToggleRow
              title={t("configView.sidebarPrefs.liveActivity")}
              description={
                <>
                  {t("configView.sidebarPrefs.liveActivityHint")}
                  <br />
                  {liveActivityDefaultDescription()} {t("quickSettings.personal.browserOnly")}
                </>
              }
              checked={props.sidebarLiveActivity}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  sidebarLiveActivity: enabled,
                })
              }
            />
          }
          {
            <SettingsToggleRow
              title={t("configView.sidebarPrefs.deleteConfirm")}
              description={
                <>
                  {t("configView.sidebarPrefs.deleteConfirmHint")}
                  <br />
                  {deleteConfirmDefaultDescription()} {t("quickSettings.personal.browserOnly")}
                </>
              }
              checked={sessionDeleteConfirm()}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  sessionDeleteConfirm: enabled,
                })
              }
            />
          }
        </div>
        {hiddenCatalogIds().length > 0 ? (
          <>
            <div class="settings-section__header settings-section__header--subsection">
              <h3 class="settings-section__heading">{t("chat.sidebar.hiddenSessionSections")}</h3>
            </div>
            <div class="settings-group">
              {
                <For each={hiddenCatalogIds()}>
                  {(catalogId) => (
                    <SettingsRow
                      title={props.hiddenSessionCatalogLabels.get(catalogId) ?? catalogId}
                      description={t("quickSettings.personal.browserOnly")}
                      control={
                        <>
                          <button
                            type="button"
                            class="btn btn--sm"
                            onClick={() => props.setSessionCatalogHidden(catalogId, false)}
                          >
                            {t("chat.sidebar.showSessionSection")}
                          </button>
                        </>
                      }
                    />
                  )}
                </For>
              }
            </div>
          </>
        ) : undefined}
        <div class="settings-section__header settings-section__header--subsection">
          <h3 class="settings-section__heading">{t("configView.sessionObserver.title")}</h3>
        </div>
        <p class="settings-section__desc">{t("configView.sessionObserver.hint")}</p>
        {
          <SessionObserverSettings
            enabled={props.sessionObserverEnabled !== false}
            utilityModel={props.sessionObserverUtilityModel}
            resolvedUtilityModel={props.sessionObserverResolvedModel}
            models={props.sessionObserverModels ?? []}
            modelsUnavailable={props.sessionObserverModelsUnavailable === true}
            disabled={props.sessionObserverDisabled === true}
            onEnabledChange={(enabled) => props.setSessionObserverEnabled?.(enabled)}
            onUtilityModelChange={(selection) => props.setSessionObserverUtilityModel?.(selection)}
          />
        }
      </section>
    </>
  );
}
