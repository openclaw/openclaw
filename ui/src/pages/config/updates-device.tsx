import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  latest,
  Loading,
  refresh,
  Show,
} from "solid-js";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import {
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { UpdatesCommandPresentation } from "./updates-types.ts";

export function DeviceUpdates(props: {
  capability: NativeDeviceSettingsCapability;
  captureCommandPresentation: () => UpdatesCommandPresentation;
}) {
  const native = createMemo(() => projectNativeDeviceSettings(props.capability));
  const snapshot = () => native().read();
  const updates = () => snapshot()?.updates;
  const [automatic, setAutomatic] = createOptimistic(() => updates()?.automatic ?? false);
  const [saving, setSaving] = createOptimistic(false);
  const [completed, setCompleted] = createSignal<Promise<void> | null>(null);
  const outcome = createMemo(async () => completed());
  const checked = createMemo(() => {
    if (!saving() && completed()) {
      latest(outcome);
    }
    return automatic();
  });
  let requestedValue = false;
  const presentChange = action(function* (
    view: UpdatesCommandPresentation,
    value: boolean,
    completion: Promise<void>,
  ) {
    if (view.isCurrent()) {
      setAutomatic(value);
      setSaving(true);
    }
    // The async receipt owns errors; this action owns only the saving affordance.
    yield completion.catch(() => {});
    if (view.isCurrent()) {
      yield refresh(automatic);
    }
  });
  const changeAutomatic = async (value: boolean) => {
    const view = props.captureCommandPresentation();
    requestedValue = value;
    const capability = props.capability;
    const pending = new Promise<void>((resolve, reject) => {
      void capability.set("updates.automatic", value, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    const completion = Promise.race([pending, view.retired]);
    void setCompleted(() => completion);
    await Promise.resolve();
    return presentChange(view, value, completion);
  };
  return (
    <Show when={snapshot() && updates()}>
      <SettingsSection title={t(deviceSettingsGroupLabelKey(snapshot()!))}>
        <SettingsRow
          title={t("updates.device.version")}
          control={
            <SettingsValue
              value={t("updates.device.versionBuild", {
                version: snapshot()!.device.appVersion,
                build: snapshot()!.device.appBuild,
              })}
            />
          }
        />
        <Show
          when={updates()!.available}
          fallback={
            <SettingsRow
              title={t("updates.device.unavailable")}
              description={updates()!.unavailableReason}
            />
          }
        >
          <Errored
            fallback={(error, reset) => (
              <SettingsRow
                title={t("updates.device.automatic")}
                description={formatUiError(error())}
                control={
                  <button
                    class="btn btn--sm"
                    type="button"
                    onClick={() => {
                      reset();
                      void changeAutomatic(requestedValue);
                    }}
                  >
                    {t("common.retry")}
                  </button>
                }
              />
            )}
          >
            <Loading fallback={<SettingsValue value={t("common.saving")} />}>
              <SettingsToggleRow
                title={t("updates.device.automatic")}
                checked={checked()}
                saving={saving()}
                description={saving() ? t("common.saving") : undefined}
                onChange={(value) => void changeAutomatic(value)}
              />
            </Loading>
          </Errored>
          <SettingsRow
            title={t("updates.device.check")}
            control={
              <button
                class="btn primary"
                type="button"
                onClick={() => props.capability.checkForUpdates()}
              >
                {t("updates.device.check")}
              </button>
            }
          />
        </Show>
      </SettingsSection>
    </Show>
  );
}
