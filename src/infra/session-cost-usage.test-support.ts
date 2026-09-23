import { vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";

/** Keep each usage fixture's databases alive until their suite settles them. */
export function createSessionCostTestRoots() {
  const tracker = createSuiteTempRootTracker({ prefix: "openclaw-session-cost-" });
  const roots = new Set<string>();
  return {
    setup: tracker.setup,
    make: async (prefix: string): Promise<string> => {
      const root = await tracker.make(prefix);
      roots.add(root);
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      return root;
    },
    cleanup: async (): Promise<void> => {
      for (const stateDir of roots) {
        await cleanupSessionStateForTest({ stateDir });
      }
      await tracker.cleanup();
      roots.clear();
    },
  };
}
