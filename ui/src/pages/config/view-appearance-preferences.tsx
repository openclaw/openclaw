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
type LocalToggle =
  | "chatShowTaskProgress"
  | "chatCollapseTaskProgress"
  | "composerHoldToRecord"
  | "sidebarLiveActivity"
  | "sessionDeleteConfirm";

function LocalToggleRow(props: {
  config: ConfigProps;
  setting: LocalToggle;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <SettingsToggleRow
      title={props.title}
      description={
        <>
          {props.hint}
          <br />
          <SettingsDefaultDescription
            value={t(UI_APPEARANCE_DEFAULTS[props.setting] ? "common.enabled" : "common.disabled")}
            overridden={props.config[props.setting] !== UI_APPEARANCE_DEFAULTS[props.setting]}
          />{" "}
          {t("quickSettings.personal.browserOnly")}
        </>
      }
      checked={props.config[props.setting]}
      onChange={(enabled) => props.config.onAppearanceChange({ [props.setting]: enabled })}
      disabled={props.disabled}
    />
  );
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
  // The value binding rewrites the DOM whenever it reruns. Track only the stored
  // width so unrelated settings refreshes keep an uncommitted draft.
  const messageWidth = createMemo(() => props.chatMessageMaxWidth ?? "");
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
                    value={messageWidth()}
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
            <LocalToggleRow
              config={props}
              setting="chatShowTaskProgress"
              title={t("configView.chatPrefs.showTaskProgress")}
              hint={t("configView.chatPrefs.showTaskProgressHint")}
            />
          }
          {
            <LocalToggleRow
              config={props}
              setting="chatCollapseTaskProgress"
              title={t("configView.chatPrefs.collapseTaskProgress")}
              hint={t("configView.chatPrefs.collapseTaskProgressHint")}
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
            <LocalToggleRow
              config={props}
              setting="composerHoldToRecord"
              title={t("chat.composer.holdToRecordSetting")}
              hint={t("chat.composer.holdToRecordSettingDescription")}
            />
          }
        </div>
      </section>
    </>
  );
}
export function SidebarPreferencesSection(props: ConfigProps) {
  const hiddenCatalogIds = createMemo(() => [...props.hiddenSessionCatalogIds].toSorted());

  // The delete dialog's "Don't ask me again" writes this off; this row is where
  // the operator turns it back on, so it has to stay next to the session prefs.

  return (
    <>
      <section id={APPEARANCE_SETTINGS_TARGET_IDS.sidebar} class="settings-section">
        {<SettingsSectionHeader title={t("configView.sidebarPrefs.title")} />}
        <p class="settings-section__desc">{t("configView.sidebarPrefs.hint")}</p>
        <div class="settings-group">
          {
            <LocalToggleRow
              config={props}
              setting="sidebarLiveActivity"
              title={t("configView.sidebarPrefs.liveActivity")}
              hint={t("configView.sidebarPrefs.liveActivityHint")}
            />
          }
          {
            <LocalToggleRow
              config={props}
              setting="sessionDeleteConfirm"
              title={t("configView.sidebarPrefs.deleteConfirm")}
              hint={t("configView.sidebarPrefs.deleteConfirmHint")}
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
