import { beforeEach, describe, expect, it, vi } from "vitest";

const closeTrackedBrowserTabsForSessionsImpl = vi.hoisted(() => vi.fn());
const movePathToTrashImpl = vi.hoisted(() => vi.fn());

vi.mock("../../extensions/browser/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabsForSessionsImpl,
  movePathToTrash: movePathToTrashImpl,
}));

describe("browser maintenance", () => {
  beforeEach(() => {
    closeTrackedBrowserTabsForSessionsImpl.mockReset();
    movePathToTrashImpl.mockReset();
  });

  it("skips browser cleanup when no session keys are provided", async () => {
    closeTrackedBrowserTabsForSessionsImpl.mockResolvedValue(0);

    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [] })).resolves.toBe(0);
    expect(closeTrackedBrowserTabsForSessionsImpl).toHaveBeenCalledWith({ sessionKeys: [] });
    expect(movePathToTrashImpl).not.toHaveBeenCalled();
  });

  it("delegates cleanup through the browser maintenance surface", async () => {
    closeTrackedBrowserTabsForSessionsImpl.mockResolvedValue(2);

    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:test"] }),
    ).resolves.toBe(2);
    expect(closeTrackedBrowserTabsForSessionsImpl).toHaveBeenCalledWith({
      sessionKeys: ["agent:main:test"],
    });
  });

  it("delegates move-to-trash through the browser maintenance surface", async () => {
    movePathToTrashImpl.mockImplementation(async (targetPath: string) => `${targetPath}.trashed`);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/tmp/demo.trashed");
    expect(movePathToTrashImpl).toHaveBeenCalledWith("/tmp/demo");
  });
});
