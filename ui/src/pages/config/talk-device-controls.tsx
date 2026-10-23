import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  latest,
  Loading,
  refresh,
  Show,
} from "solid-js";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "./settings-select-row.tsx";

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

type VoiceToggle = (typeof voiceToggles)[number];
type VoiceSetting = `voice.${VoiceToggle}` | "voice.microphone";
type VoiceScope = { capability: NativeDeviceSettingsCapability; retired: Promise<void> };
type VoiceControlProps = {
  scope: VoiceScope;
  snapshot: NativeDeviceSettingsSnapshot;
  isCurrent: () => boolean;
  presentationRetired: () => Promise<void>;
};

export function voiceControlErrorFallback(retry: () => void) {
  return (error: () => unknown, reset: () => void) => (
    <div class="callout danger" role="alert">
      {formatUiError(error())}
      <button
        class="btn btn--sm"
        type="button"
        onClick={() => {
          retry();
          reset();
        }}
      >
        {t("common.retry")}
      </button>
    </div>
  );
}

function createVoiceEdit<T extends boolean | string | null>(
  props: VoiceControlProps,
  key: () => VoiceSetting,
  read: () => T,
) {
  const [value, setValue] = createOptimistic(read);
  const [saving, setSaving] = createOptimistic(false);
  type Command = { value: T; result: Promise<void>; supersede: () => void };
  const [command, setCommand] = createSignal<Command | null>(null);
  const outcome = createMemo(async () => {
    await command()?.result;
    return null;
  });
  const present = action(function* (
    pending: Promise<void>,
    desired: T,
    retired: Promise<void>,
    superseded: Promise<void>,
    current: () => boolean,
  ) {
    try {
      if (current()) {
        setValue(() => desired);
        setSaving(true);
      }
      yield Promise.race([pending, retired, superseded]);
      if (current()) {
        // Native already accepted and published its result; no second host request.
        yield refresh(value);
      }
    } catch (error) {
      if (current()) {
        throw error;
      }
    }
  });
  function submit(desired: T) {
    if (!props.isCurrent()) {
      return;
    }
    const retired = props.presentationRetired();
    const pending = new Promise<void>((resolve, reject) => {
      void props.scope.capability.set(key(), desired, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    const previous = command();
    const completion = Promise.withResolvers<void>();
    const superseded = Promise.withResolvers<void>();
    const receipt: Command = {
      value: desired,
      result: completion.promise,
      supersede: superseded.resolve,
    };
    setCommand(receipt);
    // A newer edit retires only the old optimistic layer, never its native write.
    previous?.supersede();
    // Publish the receipt and native admission before joining its optimistic presentation.
    void Promise.resolve()
      .then(() =>
        present(
          pending,
          desired,
          retired,
          superseded.promise,
          () => props.isCurrent() && command() === receipt,
        ),
      )
      .then(completion.resolve, completion.reject);
  }
  return {
    value,
    saving,
    outcome,
    submit,
    retry: () => {
      const previous = command();
      if (previous) {
        submit(previous.value);
      }
    },
  };
}

function VoiceWriteStatus(props: {
  edit: Pick<ReturnType<typeof createVoiceEdit>, "saving" | "outcome" | "retry">;
}) {
  return (
    <>
      <Show when={props.edit.saving()}>
        <span class="muted" role="status">
          {t("common.saving")}
        </span>
      </Show>
      <Show when={!props.edit.saving()}>
        <Errored fallback={voiceControlErrorFallback(() => props.edit.retry())}>
          <Loading>{latest(props.edit.outcome)}</Loading>
        </Errored>
      </Show>
    </>
  );
}

function VoiceToggleRow(props: VoiceControlProps & { setting: VoiceToggle }) {
  const voice = () => props.snapshot.voice;
  const edit = createVoiceEdit(
    props,
    () => `voice.${props.setting}`,
    () => voice()[props.setting] ?? false,
  );
  return (
    <>
      <SettingsToggleRow
        title={t(`configPage.deviceTalk.${props.setting}`)}
        checked={edit.value()}
        disabled={props.setting === "wakeEnabled" && !voice().supported && !voice().wakeEnabled}
        description={
          props.setting === "wakeEnabled" && !voice().supported
            ? t(
                props.snapshot.device.platform === "macos"
                  ? "configPage.deviceTalk.unsupported"
                  : "configPage.deviceTalk.unsupportedDevice",
              )
            : props.setting === "realtimeRelayEnabled"
              ? t("configPage.deviceTalk.realtimeRelayHint")
              : undefined
        }
        onChange={(value) => edit.submit(value)}
      />
      <VoiceWriteStatus edit={edit} />
    </>
  );
}

function VoiceMicrophoneRow(props: VoiceControlProps) {
  const microphone = () => props.snapshot.voice.microphone;
  const edit = createVoiceEdit(
    props,
    () => "voice.microphone",
    () => microphone()?.selectedId ?? null,
  );
  const options = createMemo(() => {
    const current = microphone();
    const choices = [
      { value: "", label: t("configPage.deviceTalk.systemDefault") },
      ...(current?.devices.map(({ id, name }) => ({ value: id, label: name })) ?? []),
    ];
    const selected = edit.value();
    if (selected && !current?.devices.some(({ id }) => id === selected)) {
      choices.push({
        value: selected,
        label: t("configPage.deviceTalk.disconnectedMicrophone", { id: selected }),
      });
    }
    return choices;
  });
  return (
    <>
      <SettingsSelectRow
        title={t("configPage.deviceTalk.microphone")}
        value={edit.value() ?? ""}
        options={options()}
        onChange={(value) => edit.submit(value || null)}
      />
      <VoiceWriteStatus edit={edit} />
    </>
  );
}

export function NativeVoiceControls(props: {
  capability: NativeDeviceSettingsCapability;
  snapshot: NativeDeviceSettingsSnapshot;
  presentationRetired: () => Promise<void>;
}) {
  const scope = createMemo(
    () => ({ capability: props.capability, retired: props.presentationRetired() }),
    {
      equals: (previous, next) =>
        previous.capability === next.capability && previous.retired === next.retired,
    },
  );
  return (
    <Show when={scope()} keyed>
      {(capturedScope) => {
        const isCurrent = () =>
          capturedScope.capability === props.capability &&
          capturedScope.retired === props.presentationRetired();
        return (
          <>
            <For each={voiceToggles} keyed={(key) => key}>
              {(key) => (
                <Show when={props.snapshot.voice[key()] !== undefined}>
                  <VoiceToggleRow
                    scope={capturedScope}
                    snapshot={props.snapshot}
                    isCurrent={isCurrent}
                    presentationRetired={props.presentationRetired}
                    setting={key()}
                  />
                </Show>
              )}
            </For>
            <Show when={props.snapshot.voice.microphone}>
              <VoiceMicrophoneRow
                scope={capturedScope}
                snapshot={props.snapshot}
                isCurrent={isCurrent}
                presentationRetired={props.presentationRetired}
              />
            </Show>
          </>
        );
      }}
    </Show>
  );
}
