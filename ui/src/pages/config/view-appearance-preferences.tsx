import { createEffect, createMemo, Show, For } from "solid-js";
import type { ServerUiPrefProvenance } from "../../app/server-prefs.ts";
import {
  normalizeCatalogOpenTarget,
  normalizeChatMessageMaxWidth,
  normalizeChatFollowUpMode,
  normalizeChatSendShortcut,
  UI_APPEARANCE_DEFAULTS,
} from "../../app/settings.ts";
import {
  SettingsDefaultDescription,
  SettingsRow,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { languageLabel, LanguageSelect } from "./language-select.tsx";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { SessionObserverSettings } from "./session-observer-settings.tsx";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
import { SettingsSelectRow } from "./settings-select-row.tsx";
import type { ConfigProps } from "./view-types.ts";

export { LobsterPetSection } from "./view-appearance-lobster.tsx";
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
  const defaultDescription = (
    <SettingsDefaultDescription
      value={props.localeResetValue ? languageLabel(props.localeResetValue) : t("common.system")}
      overridden={props.localeOverridden}
    />
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
                  {defaultDescription} {provenance()}
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
            value={selectedDeviceId()}
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
              <For each={selectOptions()} keyed={(option) => option.value}>
                {(option) => (
                  <option value={option().value} selected={option().value === selectedDeviceId()}>
                    {option().label}
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
  const messageWidthDefaultDescription = (
    <SettingsDefaultDescription
      value={UI_APPEARANCE_DEFAULTS.chatMessageMaxWidth}
      overridden={props.chatMessageMaxWidth !== undefined}
    />
  );
  const sendShortcutDefaultDescription = (
    <SettingsDefaultDescription
      value={
        props.chatSendShortcutResetValue === "modifier-enter"
          ? t("chat.sendShortcutModifierEnter")
          : t("chat.sendShortcutEnter")
      }
      overridden={props.chatSendShortcutOverridden}
    />
  );
  const sendShortcutProvenance = createMemo(() =>
    serverUiPrefProvenanceHint(props.chatSendShortcutProvenance),
  );
  const followUpProvenance = createMemo(() =>
    serverUiPrefProvenanceHint(props.chatFollowUpModeProvenance),
  );
  const catalogTargetDefaultDescription = (
    <SettingsDefaultDescription
      value={t("chat.catalogOpenTargetViewer")}
      overridden={props.catalogOpenTarget !== UI_APPEARANCE_DEFAULTS.catalogOpenTarget}
    />
  );
  const holdToRecordDefaultDescription = (
    <SettingsDefaultDescription
      value={t("common.enabled")}
      overridden={props.composerHoldToRecord !== UI_APPEARANCE_DEFAULTS.composerHoldToRecord}
    />
  );
  const showTaskProgressDefaultDescription = (
    <SettingsDefaultDescription
      value={t("common.enabled")}
      overridden={props.chatShowTaskProgress !== UI_APPEARANCE_DEFAULTS.chatShowTaskProgress}
    />
  );
  const collapseTaskProgressDefaultDescription = (
    <SettingsDefaultDescription
      value={t("common.disabled")}
      overridden={
        props.chatCollapseTaskProgress !== UI_APPEARANCE_DEFAULTS.chatCollapseTaskProgress
      }
    />
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
                  {messageWidthDefaultDescription} {t("quickSettings.personal.browserOnly")}
                </>
              }
              control={
                <>
                  <input
                    class="settings-input"
                    data-settings-chat-message-width
                    aria-label={t("configView.chatPrefs.messageWidth")}
                    type="text"
                    spellcheck="false"
                    placeholder="48rem"
                    value={props.chatMessageMaxWidth ?? ""}
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
                  {showTaskProgressDefaultDescription} {t("quickSettings.personal.browserOnly")}
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
                  {collapseTaskProgressDefaultDescription} {t("quickSettings.personal.browserOnly")}
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
                  {sendShortcutDefaultDescription} {sendShortcutProvenance()}
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
                    value={followUpSelection()}
                    onChange={(event: Event) => {
                      // SAFETY: This change handler is bound directly to the native select.
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
                  {catalogTargetDefaultDescription} {t("quickSettings.personal.browserOnly")}
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
                  {holdToRecordDefaultDescription} {t("quickSettings.personal.browserOnly")}
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
export function SidebarPreferencesSection(props: ConfigProps) {
  const hiddenCatalogIds = createMemo(() => [...props.hiddenSessionCatalogIds].toSorted());
  const liveActivityDefaultDescription = (
    <SettingsDefaultDescription
      value={t("common.enabled")}
      overridden={props.sidebarLiveActivity !== UI_APPEARANCE_DEFAULTS.sidebarLiveActivity}
    />
  );
  // The delete dialog's "Don't ask me again" writes this off; this row is where
  // the operator turns it back on, so it has to stay next to the session prefs.
  const sessionDeleteConfirm = createMemo(() => props.sessionDeleteConfirm);
  const deleteConfirmDefaultDescription = (
    <SettingsDefaultDescription
      value={t("common.enabled")}
      overridden={sessionDeleteConfirm() !== UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm}
    />
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
                  {liveActivityDefaultDescription} {t("quickSettings.personal.browserOnly")}
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
                  {deleteConfirmDefaultDescription} {t("quickSettings.personal.browserOnly")}
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
