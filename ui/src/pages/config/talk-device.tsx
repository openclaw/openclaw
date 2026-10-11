import { createMemo, For } from "solid-js";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import {
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "./settings-select-row.tsx";

registerEnglishCatalog(registerSettingsEnglish);

type DeviceLocaleSelection = { primary: string; additional: string[] };
const pendingDeviceLocales = new WeakMap<
  NativeDeviceSettingsCapability,
  Partial<DeviceLocaleSelection>
>();

function deviceLocaleSelection(
  capability: NativeDeviceSettingsCapability,
): DeviceLocaleSelection | null {
  const locale = capability.snapshot?.voice.locale;
  if (!locale) {
    return null;
  }
  const pending = pendingDeviceLocales.get(capability);
  const primary = pending?.primary ?? locale.primary;
  return {
    primary,
    additional: [...new Set(pending?.additional ?? locale.additional)].filter(
      (id) => id !== primary,
    ),
  };
}

function changeDeviceLocales(
  capability: NativeDeviceSettingsCapability,
  change: Partial<DeviceLocaleSelection>,
) {
  const pending = pendingDeviceLocales.get(capability);
  if (pending) {
    Object.assign(pending, change);
  } else {
    const desired = { ...change };
    pendingDeviceLocales.set(capability, desired);
    const unsubscribe = capability.subscribe((snapshot) => {
      // Only a published snapshot can acknowledge an intent. Reading the old
      // snapshot during another edit must not clear a pending return to that value.
      const locale = snapshot.voice.locale;
      if (!locale) {
        pendingDeviceLocales.delete(capability);
        unsubscribe();
        return;
      }
      if (desired.primary === locale.primary) {
        delete desired.primary;
      }
      if (
        desired.additional &&
        desired.additional.length === locale.additional.length &&
        desired.additional.every((id, index) => id === locale.additional[index])
      ) {
        delete desired.additional;
      }
      if (desired.primary === undefined && desired.additional === undefined) {
        pendingDeviceLocales.delete(capability);
        unsubscribe();
      }
    });
  }
  if (change.additional) {
    capability.set("voice.locale.additional", change.additional);
  }
  if (change.primary !== undefined) {
    capability.set("voice.locale.primary", change.primary);
  }
}

export type VoiceWakeEditorState =
  | { kind: "unavailable" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; text: string; phase: "saved" | "pending" | "saving"; error: string | null };

export function VoiceWakeEditor(props: {
  state: VoiceWakeEditorState;
  onInput: (text: string) => void;
  onRetry: () => void;
}) {
  const ready = () => props.state.kind === "ready";
  const text = () => (props.state.kind === "ready" ? props.state.text : "");
  const error = () =>
    props.state.kind === "error" || props.state.kind === "ready" ? props.state.error : null;
  return (
    <SettingsSection title={t("configPage.deviceTalk.triggerWords")}>
      <SettingsRow
        title={t("configPage.deviceTalk.triggerWords")}
        description={t("configPage.deviceTalk.triggerWordsHint")}
        stacked
        control={
          <>
            {ready() && (
              <textarea
                class="settings-input"
                aria-label={t("configPage.deviceTalk.triggerWords")}
                rows={4}
                value={text()}
                onInput={(event) => props.onInput(event.currentTarget.value)}
              />
            )}
            {error() ? (
              <div class="callout danger" role="alert">
                {error()}
                <button class="btn btn--sm" type="button" onClick={() => props.onRetry()}>
                  {t("common.retry")}
                </button>
              </div>
            ) : props.state.kind === "unavailable" ? (
              <span class="muted">{t("configPage.deviceTalk.triggerWordsUnavailable")}</span>
            ) : (
              <span class="muted" role="status">
                {props.state.kind === "loading"
                  ? t("common.loading")
                  : props.state.kind === "ready" && props.state.phase !== "saved"
                    ? t("common.saving")
                    : t("configPage.deviceTalk.saved")}
              </span>
            )}
          </>
        }
      />
    </SettingsSection>
  );
}

const voiceToggles = [
  "wakeEnabled",
  "wakeTriggersTalkMode",
  "pushToTalkEnabled",
  "talkShiftToStopEnabled",
  "talkPhaseSoundsEnabled",
  "realtimeRelayEnabled",
  "triggerChime",
  "sendChime",
  "talkEnabled",
  "talkButtonEnabled",
  "talkBackgroundEnabled",
  "speakerphoneEnabled",
] as const;

function DeviceVoiceSettings(props: {
  capability: NativeDeviceSettingsCapability;
  snapshot: NativeDeviceSettingsSnapshot;
}) {
  const voice = () => props.snapshot.voice;
  const microphone = () => voice().microphone;
  const microphoneOptions = createMemo(() => {
    const current = microphone();
    const options = [
      { value: "", label: t("configPage.deviceTalk.systemDefault") },
      ...(current?.devices.map(({ id, name }) => ({ value: id, label: name })) ?? []),
    ];
    if (current?.selectedId && !current.devices.some(({ id }) => id === current.selectedId)) {
      options.push({
        value: current.selectedId,
        label: t("configPage.deviceTalk.disconnectedMicrophone", { id: current.selectedId }),
      });
    }
    return options;
  });
  const languageOptions = createMemo(() =>
    (voice().locale?.available ?? []).map(({ id, name }) => ({ value: id, label: name })),
  );
  const locale = createMemo(() => {
    // Reading the published snapshot invalidates the pending-intent overlay.
    void props.snapshot;
    return deviceLocaleSelection(props.capability);
  });
  return (
    <>
      <For each={voiceToggles} keyed={(key) => key}>
        {(key) => (
          <>
            {voice()[key()] !== undefined && (
              <SettingsToggleRow
                title={t(`configPage.deviceTalk.${key()}`)}
                checked={voice()[key()] ?? false}
                disabled={key() === "wakeEnabled" && !voice().supported && !voice().wakeEnabled}
                description={
                  key() === "wakeEnabled" && !voice().supported
                    ? t(
                        props.snapshot.device.platform === "macos"
                          ? "configPage.deviceTalk.unsupported"
                          : "configPage.deviceTalk.unsupportedDevice",
                      )
                    : key() === "realtimeRelayEnabled"
                      ? t("configPage.deviceTalk.realtimeRelayHint")
                      : undefined
                }
                onChange={(value) => props.capability.set(`voice.${key()}`, value)}
              />
            )}
          </>
        )}
      </For>
      {microphone() && (
        <SettingsSelectRow
          title={t("configPage.deviceTalk.microphone")}
          value={microphone()?.selectedId ?? ""}
          options={microphoneOptions()}
          onChange={(value) => props.capability.set("voice.microphone", value || null)}
        />
      )}
      {locale() && (
        <SettingsSelectRow
          title={t("configPage.deviceTalk.primaryLanguage")}
          value={locale()!.primary}
          options={languageOptions()}
          onChange={(value) => {
            const current = deviceLocaleSelection(props.capability);
            if (current) {
              changeDeviceLocales(props.capability, {
                primary: value,
                ...(current.additional.includes(value)
                  ? { additional: current.additional.filter((id) => id !== value) }
                  : {}),
              });
            }
          }}
        />
      )}
      {locale() && (
        <SettingsRow
          title={t("configPage.deviceTalk.additionalLanguages")}
          stacked
          control={
            <>
              <For each={locale()!.additional} keyed={(id) => id}>
                {(id) => {
                  const name = () =>
                    languageOptions().find((option) => option.value === id())?.label ?? id();
                  return (
                    <div>
                      {name()}
                      <button
                        class="btn btn--sm"
                        type="button"
                        aria-label={t("configPage.deviceTalk.removeLanguage", { name: name() })}
                        onClick={() => {
                          const current = deviceLocaleSelection(props.capability);
                          if (current) {
                            changeDeviceLocales(props.capability, {
                              additional: current.additional.filter((value) => value !== id()),
                            });
                          }
                        }}
                      >
                        {t("common.remove")}
                      </button>
                    </div>
                  );
                }}
              </For>
              <select
                class="settings-select"
                aria-label={t("configPage.deviceTalk.addLanguage")}
                onChange={(event) => {
                  const select = event.currentTarget;
                  const current = deviceLocaleSelection(props.capability);
                  if (
                    select.value &&
                    current &&
                    select.value !== current.primary &&
                    !current.additional.includes(select.value)
                  ) {
                    changeDeviceLocales(props.capability, {
                      additional: [...current.additional, select.value],
                    });
                    select.value = "";
                  }
                }}
              >
                <option value="">{t("configPage.deviceTalk.addLanguage")}</option>
                <For
                  each={languageOptions().filter(
                    ({ value }) =>
                      value !== locale()!.primary && !locale()!.additional.includes(value),
                  )}
                  keyed={(option) => option.value}
                >
                  {(option) => <option value={option().value}>{option().label}</option>}
                </For>
              </select>
            </>
          }
        />
      )}
      {microphone() && (
        <SettingsRow
          title={t("configPage.deviceTalk.microphoneTest")}
          control={
            <button
              class="btn btn--sm"
              type="button"
              onClick={() => props.capability.openPanel("microphone-test")}
            >
              {t("configPage.deviceTalk.microphoneTest")}
            </button>
          }
        />
      )}
    </>
  );
}

export function DeviceTalk(props: {
  capability?: NativeDeviceSettingsCapability | null;
  snapshot?: NativeDeviceSettingsSnapshot | null;
}) {
  return (
    <>
      {props.capability && (
        <SettingsSection title={t(deviceSettingsGroupLabelKey(props.snapshot))}>
          {props.snapshot?.voice ? (
            <DeviceVoiceSettings capability={props.capability} snapshot={props.snapshot} />
          ) : (
            <SettingsRow title={t("common.loading")} />
          )}
        </SettingsSection>
      )}
    </>
  );
}
