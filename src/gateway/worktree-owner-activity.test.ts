import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_GC_MS } from "../agents/worktrees/service.js";
import { isManagedWorktreeOwnerActive } from "./worktree-owner-activity.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("isManagedWorktreeOwnerActive", () => {
  it("recognizes only recently active session owners", () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const entries: Record<string, { lastInteractionAt?: number; updatedAt?: number }> = {
      "agent:main:live": { lastInteractionAt: now - 1_000 },
      "agent:main:stale": { updatedAt: now - IDLE_GC_MS - 1 },
    };
    mocks.loadSessionEntry.mockImplementation((ownerId: string) => ({
      entry: entries[ownerId],
    }));

    expect(isManagedWorktreeOwnerActive("session", "agent:main:live")).toBe(true);
    expect(isManagedWorktreeOwnerActive("session", "agent:main:stale")).toBe(false);
    expect(isManagedWorktreeOwnerActive("manual", "agent:main:live")).toBe(false);
    expect(isManagedWorktreeOwnerActive("session", "agent:main:missing")).toBe(false);
  });

  it("treats unreadable session state as inactive", () => {
    mocks.loadSessionEntry.mockImplementation(() => {
      throw new Error("unreadable session store");
    });

    expect(isManagedWorktreeOwnerActive("session", "agent:main:live")).toBe(false);
  });
});
