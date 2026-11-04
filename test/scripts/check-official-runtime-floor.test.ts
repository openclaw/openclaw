import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRuntimeFloorCandidates,
  partitionTypecheckErrors,
  planRuntimeFloorChecks,
} from "../../scripts/check-official-runtime-floor.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const codex = {
  pluginId: "codex",
  versionBoundToOpenClaw: true,
  minimumCompatibleVersion: "2026.10.6",
};

function plan(params: Partial<Parameters<typeof planRuntimeFloorChecks>[0]> = {}) {
  return planRuntimeFloorChecks({
    hostVersion: "2026.10.7",
    candidates: [codex],
    isReleased: () => true,
    hasSource: () => true,
    ...params,
  });
}

describe("planRuntimeFloorChecks", () => {
  it("type-checks a released floor", () => {
    expect(plan()).toEqual([
      { pluginId: "codex", floor: "2026.10.6", action: "check", tag: "v2026.10.6" },
    ]);
  });

  it("skips an unreleased floor because nothing older can be admitted", () => {
    expect(
      plan({
        hostVersion: "2026.10.10-beta.4",
        candidates: [{ ...codex, minimumCompatibleVersion: "2026.10.10-beta.4" }],
        isReleased: () => false,
      }),
    ).toEqual([{ pluginId: "codex", floor: "2026.10.10-beta.4", action: "skip-unreleased" }]);
  });

  it("fails a floor above the release, which would refuse the matching runtime", () => {
    expect(
      plan({
        hostVersion: "2026.10.6",
        candidates: [{ ...codex, minimumCompatibleVersion: "2026.10.7" }],
      }),
    ).toEqual([expect.objectContaining({ pluginId: "codex", action: "fail" })]);
  });

  it("ignores runtimes that are not version-bound, have no floor or no source here", () => {
    expect(
      plan({
        candidates: [
          { pluginId: "acpx" },
          { pluginId: "codex", versionBoundToOpenClaw: true },
          { ...codex, pluginId: "elsewhere" },
        ],
        hasSource: (pluginId) => pluginId !== "elsewhere",
      }),
    ).toEqual([]);
  });
});

describe("partitionTypecheckErrors", () => {
  it("separates the floor runtime's errors from setup errors", () => {
    const output = [
      ".artifacts/official-runtime-floor/codex/extensions/codex/src/app-server/run-attempt-turn-state.ts(174,65): error TS2741: Property 'startedAtMonotonicMs' is missing in type '{ startedAtMs: number; }'.",
      "src/types/ambient.d.ts(3,1): error TS2300: Duplicate identifier 'X'.",
      "Found 2 errors.",
    ].join("\n");
    expect(
      partitionTypecheckErrors(output, ".artifacts/official-runtime-floor/codex/extensions/codex"),
    ).toEqual({
      runtime: [expect.stringContaining("startedAtMonotonicMs")],
      other: [expect.stringContaining("Duplicate identifier")],
    });
  });
});

describe("partitionTypecheckErrors on a failed compiler run", () => {
  it("treats a failed run without diagnostics as a broken check, not a pass", () => {
    expect(partitionTypecheckErrors("tsgo: binary not found\n", "x/extensions/codex", 1)).toEqual({
      runtime: [],
      other: [expect.stringContaining("type-check exited 1 without diagnostics")],
    });
  });

  it("passes a clean run", () => {
    expect(partitionTypecheckErrors("", "x/extensions/codex", 0)).toEqual({
      runtime: [],
      other: [],
    });
  });
});

describe("loadRuntimeFloorCandidates", () => {
  it("reads the checked release's floors, not the tooling checkout's", async () => {
    const rootDir = tempDirs.make("runtime-floor-release-");
    fs.mkdirSync(path.join(rootDir, "src", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src", "plugins", "official-runtime-plugins.ts"),
      'export const CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES = [{ pluginId: "codex", versionBoundToOpenClaw: true, minimumCompatibleVersion: "2026.1.1" }];\n',
    );
    await expect(loadRuntimeFloorCandidates(rootDir)).resolves.toEqual([
      { pluginId: "codex", versionBoundToOpenClaw: true, minimumCompatibleVersion: "2026.1.1" },
    ]);
  });

  it("reports no floors for a release that predates them", async () => {
    await expect(
      loadRuntimeFloorCandidates(tempDirs.make("runtime-floor-old-")),
    ).resolves.toBeUndefined();
  });
});
