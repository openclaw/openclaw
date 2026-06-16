// Skill refresh state tests cover snapshot version invalidation contracts.
import { beforeEach, describe, expect, it } from "vitest";
import {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
  shouldRefreshSnapshotForVersion,
} from "./refresh-state.js";

describe("skills refresh state", () => {
  beforeEach(() => {
    resetSkillsRefreshStateForTest();
  });

  it("starts above persisted version 0 so restarted sessions refresh once", () => {
    const currentVersion = getSkillsSnapshotVersion("/tmp/workspace");

    expect(currentVersion).toBeGreaterThan(0);
    expect(shouldRefreshSnapshotForVersion(0, currentVersion)).toBe(true);
  });

  it("reuses snapshots already built for the current startup version", () => {
    const currentVersion = getSkillsSnapshotVersion("/tmp/workspace");

    expect(shouldRefreshSnapshotForVersion(currentVersion, currentVersion)).toBe(false);
  });

  it("keeps workspace and global bumps above the startup version", () => {
    const workspaceVersion = bumpSkillsSnapshotVersion({ workspaceDir: "/tmp/workspace" });
    const globalVersion = bumpSkillsSnapshotVersion();

    expect(workspaceVersion).toBeGreaterThan(1);
    expect(globalVersion).toBeGreaterThanOrEqual(workspaceVersion);
    expect(getSkillsSnapshotVersion("/tmp/workspace")).toBe(globalVersion);
  });
});
