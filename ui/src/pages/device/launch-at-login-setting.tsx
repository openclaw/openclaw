import { createSignal } from "@solidjs/signals";
import { createMemo, Errored, Loading, Show } from "solid-js";
import type { NativeDeviceSettingsSnapshot } from "../../app/native-device-settings.ts";
import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerSettingsEnglish);

export function LaunchAtLoginSetting(props: {
  app: NonNullable<NativeDeviceSettingsSnapshot["app"]>;
}) {
  const capability = useApplication().nativeDeviceSettings;
  const [completion, setCompletion] = createSignal<Promise<void>>();
  const result = createMemo(() => completion()?.then(() => null) ?? null);

  return (
    <Show when={props.app.launchAtLogin !== undefined}>
      <SettingsToggleRow
        title={t("configPage.deviceSettings.launchAtLogin")}
        checked={props.app.launchAtLogin ?? false}
        disabled={props.app.launchAtLoginAvailable === false}
        description={
          <>
            {props.app.launchAtLoginAvailable === false
              ? t("configPage.deviceSettings.launchAtLoginUnavailable")
              : undefined}
            <Loading on={completion()}>
              <Errored fallback={(error) => <span role="alert">{formatUiError(error())}</span>}>
                {result()}
              </Errored>
            </Loading>
          </>
        }
        onChange={(value) => {
          if (!capability) {
            return;
          }
          const pending = Promise.withResolvers<void>();
          // A retired row must still consume the native operation's eventual failure.
          void pending.promise.catch(() => undefined);
          void capability.set("app.launchAtLogin", value, (error) => {
            return error ? pending.reject(error) : pending.resolve();
          });
          void setCompletion(pending.promise);
        }}
      />
    </Show>
  );
}
