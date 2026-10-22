import { createMemo, Errored, For, Loading, Show } from "solid-js";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "./settings-select-row.tsx";
import { NativeVoiceControls } from "./talk-device-controls.tsx";

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
  const desired = Object.assign(pendingDeviceLocales.get(capability) ?? {}, change);
  pendingDeviceLocales.set(capability, desired);
  for (const key of ["additional", "primary"] as const) {
    const value = change[key];
    if (value === undefined) {
      continue;
    }
    capability.set(`voice.locale.${key}`, value, () => {
      // Native settles before publishing its snapshot. Do not retire a newer edit.
      if (desired[key] === value) {
        delete desired[key];
      }
      if (
        desired.primary === undefined &&
        desired.additional === undefined &&
        pendingDeviceLocales.get(capability) === desired
      ) {
        pendingDeviceLocales.delete(capability);
      }
    });
  }
}

export type VoiceWakeEditorState =
  | { kind: "unavailable" }
  | { kind: "ready"; text: string; phase: "saved" | "pending" | "saving" };

function VoiceWakeWriteStatus(props: {
  saving: boolean;
  readWriteResult: () => void;
  onRetry: () => void;
}) {
  const savedLabel = () => {
    props.readWriteResult();
    return t("configPage.deviceTalk.saved");
  };
  return (
    <Errored
      fallback={(error, reset) => (
        <div class="callout danger" role="alert">
          {formatUiError(error())}
          <button
            class="btn btn--sm"
            type="button"
            onClick={() => {
              props.onRetry();
              reset();
            }}
          >
            {t("common.retry")}
          </button>
        </div>
      )}
    >
      <Loading
        fallback={
          <span class="muted" role="status">
            {t("common.saving")}
          </span>
        }
      >
        <span class="muted" role="status">
          {props.saving ? t("common.saving") : savedLabel()}
        </span>
      </Loading>
    </Errored>
  );
}

function VoiceWakeControls(props: {
  state: VoiceWakeEditorState;
  saving: boolean;
  readWriteResult: () => void;
  onInput: (text: string) => void;
  onRetry: () => void;
}) {
  const ready = () => props.state.kind === "ready";
  const text = createMemo(() => (props.state.kind === "ready" ? props.state.text : ""));
  // An empty draft still resets only the status boundary, preserving the editor.
  const statusDraft = createMemo(() => ({ text: text() }));
  return (
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
      {props.state.kind === "unavailable" ? (
        <span class="muted">{t("configPage.deviceTalk.triggerWordsUnavailable")}</span>
      ) : (
        <Show when={statusDraft()} keyed>
          {(_draft) => (
            <VoiceWakeWriteStatus
              saving={props.saving}
              readWriteResult={props.readWriteResult}
              onRetry={props.onRetry}
            />
          )}
        </Show>
      )}
    </>
  );
}

export function VoiceWakeEditor(props: {
  readState: () => VoiceWakeEditorState;
  scope?: object | null;
  saving: boolean;
  readWriteResult: () => void;
  onInput: (text: string) => void;
  onRetry: () => void;
}) {
  // Only an admitted read re-arms loading; reconnecting a retained draft keeps the editor.
  const scope = createMemo(() => props.scope);
  return (
    <SettingsSection title={t("configPage.deviceTalk.triggerWords")}>
      <SettingsRow
        title={t("configPage.deviceTalk.triggerWords")}
        description={t("configPage.deviceTalk.triggerWordsHint")}
        stacked
        control={
          <Errored
            fallback={(error, reset) => (
              <div class="callout danger" role="alert">
                {formatUiError(error())}
                <button
                  class="btn btn--sm"
                  type="button"
                  onClick={() => {
                    props.onRetry();
                    reset();
                  }}
                >
                  {t("common.retry")}
                </button>
              </div>
            )}
          >
            <Loading
              on={scope()}
              fallback={
                <span class="muted" role="status">
                  {t("common.loading")}
                </span>
              }
            >
              <VoiceWakeControls
                state={props.readState()}
                saving={props.saving}
                readWriteResult={props.readWriteResult}
                onInput={props.onInput}
                onRetry={props.onRetry}
              />
            </Loading>
          </Errored>
        }
      />
    </SettingsSection>
  );
}

function DeviceVoiceSettings(props: {
  presentationRetired: () => Promise<void>;
  capability: NativeDeviceSettingsCapability;
  snapshot: NativeDeviceSettingsSnapshot;
}) {
  const voice = () => props.snapshot.voice;
  const microphone = () => voice().microphone;
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
      <NativeVoiceControls
        capability={props.capability}
        snapshot={props.snapshot}
        presentationRetired={props.presentationRetired}
      />
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
  presentationRetired: () => Promise<void>;
  capability?: NativeDeviceSettingsCapability | null;
  snapshot?: NativeDeviceSettingsSnapshot | null;
}) {
  // The receipt only gates readiness; live owner publications stay outside this memo.
  const initialSnapshot = createMemo(() => props.capability?.initialSnapshot ?? null);
  return (
    <>
      {props.capability && (
        <SettingsSection title={t(deviceSettingsGroupLabelKey(props.snapshot))}>
          <Loading on={props.capability} fallback={<SettingsRow title={t("common.loading")} />}>
            {(props.snapshot ?? initialSnapshot()) && (
              <DeviceVoiceSettings
                presentationRetired={props.presentationRetired}
                capability={props.capability}
                snapshot={(props.snapshot ?? initialSnapshot())!}
              />
            )}
          </Loading>
        </SettingsSection>
      )}
    </>
  );
}
