// Tests browser lifecycle cleanup after CLI and runtime shutdown paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config/types.openclaw.js";

const closeTrackedBrowserTabsForSessions = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("./plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions,
}));

const { cleanupBrowserSessionsForLifecycleEnd } = await import("./browser-lifecycle-cleanup.js");

describe("cleanupBrowserSessionsForLifecycleEnd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes session keys before closing browser sessions", async () => {
    const onWarn = vi.fn();
    const isCurrent = () => true;
    const prepareCurrent = async () => true;

    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        sessionKeys: [
          "",
          "global",
          "  agent:alpha:global  ",
          "agent:alpha:global",
          "agent:beta:global",
        ],
        isCurrent,
        prepareCurrent,
        onWarn,
      }),
    ).resolves.toBeUndefined();

    expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
      sessionKeys: ["agent:alpha:global", "agent:beta:global"],
      isCurrent,
      prepareCurrent,
      onWarn,
    });
  });

  it("skips cleanup when root browser support is disabled", async () => {
    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        cfg: { browser: { enabled: false } } as OpenClawConfig,
        sessionKeys: ["agent:alpha:global"],
      }),
    ).resolves.toBeUndefined();

    expect(closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
  });

  it("skips cleanup when the browser plugin entry is disabled", async () => {
    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        cfg: { plugins: { entries: { browser: { enabled: false } } } } as OpenClawConfig,
        sessionKeys: ["agent:alpha:global"],
      }),
    ).resolves.toBeUndefined();

    expect(closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
  });

  it("swallows browser cleanup failures", async () => {
    const onError = vi.fn();
    const error = new Error("cleanup failed");
    closeTrackedBrowserTabsForSessions.mockRejectedValueOnce(error);

    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        sessionKeys: ["agent:alpha:global"],
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
