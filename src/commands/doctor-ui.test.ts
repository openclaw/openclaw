import { describe, expect, it } from "vitest";
import {
  uiProtocolFreshnessIssueToHealthFinding,
  uiProtocolFreshnessIssueToRepairEffects,
  type UiProtocolFreshnessIssue,
} from "./doctor-ui.js";

function issue(overrides: Partial<UiProtocolFreshnessIssue> = {}): UiProtocolFreshnessIssue {
  return {
    kind: "missing-assets",
    root: "/repo/openclaw",
    uiIndexPath: "/repo/openclaw/dist/control-ui/index.html",
    canBuild: true,
    ...overrides,
  } as UiProtocolFreshnessIssue;
}

describe("UI protocol freshness health mapping", () => {
  it("maps missing UI assets to a structured finding and dry-run effect", () => {
    const current = issue();

    expect(uiProtocolFreshnessIssueToHealthFinding(current)).toEqual(
      expect.objectContaining({
        checkId: "core/doctor/ui-protocol-freshness",
        severity: "warning",
        path: "/repo/openclaw/dist/control-ui/index.html",
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    );
    expect(uiProtocolFreshnessIssueToRepairEffects(current)).toEqual([
      {
        kind: "process",
        action: "would-build-control-ui",
        target: "/repo/openclaw",
        dryRunSafe: false,
      },
    ]);
  });

  it("maps stale UI assets to rebuild effects without file diffs", () => {
    const current = issue({
      kind: "stale-assets",
      changesSinceBuild: ["abc123 schema change"],
    });

    expect(uiProtocolFreshnessIssueToHealthFinding(current).message).toContain(
      "abc123 schema change",
    );
    expect(uiProtocolFreshnessIssueToRepairEffects(current)).toEqual([
      {
        kind: "process",
        action: "would-rebuild-control-ui",
        target: "/repo/openclaw",
        dryRunSafe: false,
      },
    ]);
  });

  it("does not report dry-run effects when UI sources are unavailable", () => {
    expect(uiProtocolFreshnessIssueToRepairEffects(issue({ canBuild: false }))).toEqual([]);
  });
});
