import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

export async function withHistoryState(run: () => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const registry = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetTaskRegistryForTests();
    try {
      await run();
    } finally {
      try {
        await disposeSessionReadContexts();
      } finally {
        try {
          // Release native borrowers before the registry's synchronous close.
          await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
          resetTaskRegistryForTests({ persist: false });
        } finally {
          restoreActivePluginRegistrySnapshot(registry);
        }
      }
    }
  });
}
