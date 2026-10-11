import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import * as sessionInventory from "../../config/sessions/session-entry-read-runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { drainAgentDeletionRuns } from "./agents-delete-drain.js";

const browserSurface = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn<
    typeof import("../../plugin-sdk/browser-maintenance.js").closeTrackedBrowserTabsForSessions
  >(async () => 1),
}));

// The plugin registry is private; keep the core cleanup/facade real and replace
// only the activated plugin's public maintenance surface, with no browser I/O.
vi.mock("../../plugin-sdk/facade-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/facade-runtime.js")>()),
  tryLoadActivatedBundledPluginPublicSurfaceModule: async () => browserSurface,
}));

afterEach(() => {
  vi.restoreAllMocks();
  browserSurface.closeTrackedBrowserTabsForSessions.mockClear();
});

it("hands only deleted agent sessions to browser cleanup after their producers settle", async () => {
  await withOpenClawTestState({ label: "deletion-browser-scope" }, async (state) => {
    const cfg = {
      agents: { entries: { keeper: {}, doomed: {} } },
      session: { store: state.path("agents/keeper/sessions/sessions.json") },
    };
    vi.spyOn(sessionInventory, "readSessionEntrySummariesInWorker").mockResolvedValue([
      { sessionKey: "agent:doomed:idle", entry: { sessionId: "doomed-idle", updatedAt: 1 } },
      { sessionKey: "agent:keeper:live", entry: { sessionId: "keeper-live", updatedAt: 1 } },
    ]);
    const cancelled = createDeferred();
    const producer = createEmbeddedRunHandle({
      runId: "doomed-producer",
      abort: () => cancelled.resolve(),
    });
    setActiveEmbeddedRun("doomed-active", producer, "legacy", undefined, "doomed");
    const draining = drainAgentDeletionRuns("doomed", cfg, createDirectChatContext(), () => {});
    try {
      await awaitGateBeforeSettlement(
        cancelled.promise,
        draining,
        "deletion never cancelled its active producer",
      );
      expect(browserSurface.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
      clearActiveEmbeddedRun("doomed-active", producer);
      await expect(draining).resolves.toBeUndefined();
      expect(browserSurface.closeTrackedBrowserTabsForSessions).toHaveBeenCalledExactlyOnceWith({
        sessionKeys: ["agent:doomed:legacy", "agent:doomed:idle"],
        isCurrent: expect.any(Function),
        onWarn: expect.any(Function),
      });
    } finally {
      clearActiveEmbeddedRun("doomed-active", producer);
      await Promise.allSettled([draining]);
    }
  });
});
