import type { RuntimeConfigState } from "./config-state-model.ts";

/** Matches the fade in `settings.css`; the notice leaves as its animation ends. */
const CONFIG_SAVED_NOTICE_MS = 2_000;

/** Turns each completed write into a brief notice. Status alone stays "saved" long after one. */
export function createConfigSavedNotice(state: RuntimeConfigState, publish: () => void) {
  let seenReceipts = state.configSaveReceipts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    sync() {
      if (state.configSaveReceipts === seenReceipts) {
        return;
      }
      seenReceipts = state.configSaveReceipts;
      state.configSavedNotice = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.configSavedNotice = false;
        publish();
      }, CONFIG_SAVED_NOTICE_MS);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
