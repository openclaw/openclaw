import { createSignal } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Loading } from "solid-js";
import type {
  NativeDeviceSettingsCapability,
  SettingKey,
} from "../../app/native-device-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";

/** One native edit's completion, so its failure renders on the row that issued it. */
export function createNativeEditFeedback(capability: NativeDeviceSettingsCapability | null) {
  const [completion, setCompletion] = createSignal<Promise<void>>();
  const result = createMemo(() => completion()?.then(() => null) ?? null);
  return {
    set(key: SettingKey, value: boolean | string | string[] | null) {
      if (!capability) {
        return;
      }
      const pending = Promise.withResolvers<void>();
      // A retired row must still consume the native operation's eventual failure.
      void pending.promise.catch(() => undefined);
      void capability.set(key, value, (error) => {
        return error ? pending.reject(error) : pending.resolve();
      });
      void setCompletion(pending.promise);
    },
    describe(description?: JSX.Element) {
      return (
        <>
          {description}
          {description ? " " : null}
          <Loading on={completion()}>
            <Errored fallback={(error) => <span role="alert">{formatUiError(error())}</span>}>
              {result()}
            </Errored>
          </Loading>
        </>
      );
    },
  };
}
