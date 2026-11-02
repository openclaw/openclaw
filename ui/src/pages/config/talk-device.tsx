import {
  action,
  createMemo,
  createOptimistic,
  Errored,
  For,
  Loading,
  refresh,
  Show,
} from "solid-js";
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
import { NativeVoiceControls, voiceControlErrorFallback } from "./talk-device-controls.tsx";

registerEnglishCatalog(registerSettingsEnglish);

type DeviceLocaleSelection = { primary: string; additional: string[] };
type PendingDeviceLocales = Partial<DeviceLocaleSelection> & {
  errors: Partial<Record<keyof DeviceLocaleSelection, string>>;
};
const pendingDeviceLocales = new WeakMap<NativeDeviceSettingsCapability, PendingDeviceLocales>();

function deviceLocaleSelection(capability: NativeDeviceSettingsCapability) {
  const locale = capability.snapshot?.voice.locale;
  if (!locale) {
    return null;
  }
  const pending = pendingDeviceLocales.get(capability);
  const primary = pending?.primary ?? locale.primary;
  return {
    primary,
    available: locale.available,
    additional: [...new Set(pending?.additional ?? locale.additional)].filter(
      (id) => id !== primary,
    ),
    error: pending?.errors.primary ?? pending?.errors.additional ?? null,
  };
}

function changeDeviceLocales(
  capability: NativeDeviceSettingsCapability,
  change: Partial<DeviceLocaleSelection>,
) {
  const desired: PendingDeviceLocales = Object.assign(
    pendingDeviceLocales.get(capability) ?? { errors: {} },
    change,
  );
  pendingDeviceLocales.set(capability, desired);
  const writes: Promise<void>[] = [];
  for (const key of ["additional", "primary"] as const) {
    const value = change[key];
    if (value === undefined) {
      continue;
    }
    delete desired.errors[key];
    writes.push(
      capability.set(`voice.locale.${key}`, value, (error) => {
        // Native settles before publishing its snapshot. Do not retire a newer edit.
        if (desired[key] === value) {
          if (error) {
            desired.errors[key] = formatUiError(error);
          } else {
            delete desired[key];
            delete desired.errors[key];
          }
        }
        if (
          desired.primary === undefined &&
          desired.additional === undefined &&
          pendingDeviceLocales.get(capability) === desired
        ) {
          pendingDeviceLocales.delete(capability);
        }
      }),
    );
  }
  return Promise.all(writes);
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
    <Errored fallback={voiceControlErrorFallback(() => props.onRetry())}>
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
          <Errored fallback={voiceControlErrorFallback(() => props.onRetry())}>
            <Loading
              on={scope()}
              fallback={
                <>
                  <textarea
                    class="settings-input"
                    aria-label={t("configPage.deviceTalk.triggerWords")}
                    aria-busy="true"
                    rows={4}
                    disabled
                  />
                  <span class="muted" role="status">
                    {t("common.loading")}
                  </span>
                </>
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
  // Choices and selection share one optimistic frame during overlapping native edits.
  const [locale, setLocale] = createOptimistic(() => {
    // Reading the published snapshot invalidates the pending-intent overlay.
    void props.snapshot;
    return deviceLocaleSelection(props.capability);
  });
  // Keep the controls owned by availability, not each optimistic selection frame.
  const hasLocale = createMemo(() => locale() !== null);
  const changeLocales = action(function* (completion: ReturnType<typeof changeDeviceLocales>) {
    setLocale(deviceLocaleSelection(props.capability));
    yield completion;
    // Other edits may still hold this transition open after this write settles.
    setLocale(deviceLocaleSelection(props.capability));
    void refresh(locale);
  });
  return (
    <>
      <NativeVoiceControls
        capability={props.capability}
        snapshot={props.snapshot}
        presentationRetired={props.presentationRetired}
      />
      {hasLocale() && (
        <SettingsSelectRow
          title={t("configPage.deviceTalk.primaryLanguage")}
          value={locale()!.primary}
          options={locale()!.available.map(({ id, name }) => ({ value: id, label: name }))}
          onChange={(value) => {
            const current = deviceLocaleSelection(props.capability);
            if (current) {
              void changeLocales(
                changeDeviceLocales(props.capability, {
                  primary: value,
                  ...(current.additional.includes(value)
                    ? { additional: current.additional.filter((id) => id !== value) }
                    : {}),
                }),
              );
            }
          }}
        />
      )}
      {hasLocale() && (
        <SettingsRow
          title={t("configPage.deviceTalk.additionalLanguages")}
          stacked
          control={
            <>
              <For each={locale()!.additional} keyed={(id) => id}>
                {(id) => {
                  const name = () =>
                    locale()?.available.find((language) => language.id === id())?.name ?? id();
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
                            void changeLocales(
                              changeDeviceLocales(props.capability, {
                                additional: current.additional.filter((value) => value !== id()),
                              }),
                            );
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
                    void changeLocales(
                      changeDeviceLocales(props.capability, {
                        additional: [...current.additional, select.value],
                      }),
                    );
                    select.value = "";
                  }
                }}
              >
                <option value="">{t("configPage.deviceTalk.addLanguage")}</option>
                <For
                  each={locale()!.available.filter(
                    ({ id }) => id !== locale()!.primary && !locale()!.additional.includes(id),
                  )}
                  keyed={false}
                >
                  {(option) => <option value={option().id}>{option().name}</option>}
                </For>
              </select>
            </>
          }
        />
      )}
      {locale()?.error && (
        <div class="callout danger" role="alert">
          {locale()!.error}
          <button
            class="btn btn--sm"
            type="button"
            onClick={() => {
              const pending = pendingDeviceLocales.get(props.capability);
              if (pending) {
                void changeLocales(
                  changeDeviceLocales(props.capability, {
                    ...(pending.errors.primary ? { primary: pending.primary } : {}),
                    ...(pending.errors.additional ? { additional: pending.additional } : {}),
                  }),
                );
              }
            }}
          >
            {t("common.retry")}
          </button>
        </div>
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
