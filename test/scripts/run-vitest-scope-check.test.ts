import { describe, expect, it } from "vitest";
import { evaluateDirtyManifestScope, globToRegExp } from "../../scripts/run-vitest-scope-check.mjs";

describe("scripts/run-vitest-scope-check", () => {
  it("matches simple manifest globs", () => {
    expect(globToRegExp("scripts/run-vitest*.mjs").test("scripts/run-vitest-scope-check.mjs")).toBe(
      true,
    );
    expect(globToRegExp("src/**/state-query*").test("src/agents/state-query.ts")).toBe(true);
  });

  it("allows report-only workflows while preserving the pre-existing dirty set", () => {
    const result = evaluateDirtyManifestScope({
      baselineDirtyPaths: ["docs/notes-preexisting.md"],
      currentDirtyPaths: ["docs/notes-preexisting.md", "/tmp/wave9-report.json"],
      expectedReportPaths: ["/tmp/wave9-report.json"],
    });

    expect(result.accepted).toBe(true);
    expect(result.status).toBe("PASS");
    expect(result.preservedBaselineDirtyPaths).toEqual(["docs/notes-preexisting.md"]);
    expect(result.missingBaselineDirtyPaths).toEqual([]);
    expect(result.implementationEvidencePaths).toEqual(["/tmp/wave9-report.json"]);
    expect(result.unexpectedChangedPaths).toEqual([]);
  });

  it("rejects multi-wave implementation edits outside the expected dirty manifest", () => {
    const result = evaluateDirtyManifestScope({
      baselineDirtyPaths: [
        "docs/plan/session-issues-runtime-hardening-wave0-source-map-20260517.md",
      ],
      currentDirtyPaths: [
        "docs/plan/session-issues-runtime-hardening-wave0-source-map-20260517.md",
        "scripts/run-vitest.mjs",
        "src/agents/unmapped-runtime-edit.ts",
      ],
      expectedChangedGlobs: ["scripts/run-vitest*.mjs", "src/agents/subagent-spawn.ts"],
    });

    expect(result.accepted).toBe(false);
    expect(result.status).toBe("REJECTED_SCOPE_DRIFT");
    expect(result.implementationEvidencePaths).toEqual(["scripts/run-vitest.mjs"]);
    expect(result.unexpectedChangedPaths).toEqual(["src/agents/unmapped-runtime-edit.ts"]);
  });

  it("reports split main/worktree and state drift as reconciliation, not implementation evidence", () => {
    const result = evaluateDirtyManifestScope({
      baselineDirtyPaths: [],
      currentDirtyPaths: ["STATE.md", "state/orchestrator.json"],
      expectedChangedGlobs: ["src/**"],
      derivedStateGlobs: ["STATE.md"],
      liveControlPlaneGlobs: ["state/orchestrator.json", "state/issues/*.json"],
      splitStateDifferences: ["main:STATE.md != worktree:STATE.md"],
    });

    expect(result.accepted).toBe(true);
    expect(result.status).toBe("PASS_WITH_RECONCILIATION");
    expect(result.implementationEvidencePaths).toEqual([]);
    expect(result.derivedStateDrift).toEqual(["STATE.md"]);
    expect(result.liveControlPlaneDrift).toEqual(["state/orchestrator.json"]);
    expect(result.reconciliationItems.map((item) => item.kind)).toEqual([
      "derived-state-drift",
      "live-control-plane-drift",
      "split-main-worktree-state",
    ]);
  });
});
