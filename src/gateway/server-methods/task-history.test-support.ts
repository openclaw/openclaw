import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

export async function withHistoryState(run: () => Promise<void>) {
  let registry: ReturnType<typeof captureActivePluginRegistrySnapshot> | undefined;
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      registry = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(createEmptyPluginRegistry());
      resetTaskRegistryForTests();
      try {
        await run();
      } finally {
        await disposeSessionReadContexts();
      }
    });
  } finally {
    if (registry) {
      // The fixture drains admitted work and closes its native owners before reset.
      // Its temporary state is gone; do not clear persistence in the restored env.
      try {
        resetTaskRegistryForTests({ persist: false });
      } finally {
        restoreActivePluginRegistrySnapshot(registry);
      }
    }
  }
}
