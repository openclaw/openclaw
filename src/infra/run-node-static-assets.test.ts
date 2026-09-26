import fs from "node:fs/promises";
import { describe, expect } from "vitest";
import { resolveRuntimePostBuildRequirement } from "../../scripts/run-node.mts";
import {
  it,
  DIFFS_PACKAGE,
  DIFFS_VIEWER_RUNTIME_SOURCE,
  DIST_DIFFS_VIEWER_RUNTIME,
  DIST_RUNTIME_DIFFS_VIEWER_RUNTIME,
  DIST_RUNTIME_EXTENSION_PACKAGE,
  RUNTIME_POSTBUILD_STAMP,
  createBuildRequirementDeps,
  resolvePath,
  setupStampedProject,
} from "../../test/scripts/run-node.test-support.js";

describe("run-node static asset freshness", () => {
  for (const [title, missingPath, hoisted = false] of [
    [
      "reports missing static runtime postbuild asset outputs when runtime stamps match HEAD",
      DIST_DIFFS_VIEWER_RUNTIME,
    ],
    [
      "reports missing static runtime overlay asset outputs when runtime stamps match HEAD",
      DIST_RUNTIME_DIFFS_VIEWER_RUNTIME,
    ],
    [
      "reports missing hoisted dependency static asset outputs when runtime stamps match HEAD",
      DIST_DIFFS_VIEWER_RUNTIME,
      true,
    ],
  ] as const) {
    it(title, async ({ tmp }) => {
      const dependencyAsset = "node_modules/@fixture/engine/private/viewer-runtime.js";
      await setupStampedProject(tmp, {
        files: {
          [DIFFS_PACKAGE]: JSON.stringify({
            openclaw: {
              build: {
                staticAssets: [
                  {
                    source: hoisted ? `./${dependencyAsset}` : "./assets/viewer-runtime.js",
                    output: "assets/viewer-runtime.js",
                  },
                ],
              },
            },
          }),
          [hoisted ? dependencyAsset : DIFFS_VIEWER_RUNTIME_SOURCE]: "export {};\n",
          ...(hoisted
            ? {
                "node_modules/@fixture/engine/package.json": JSON.stringify({
                  name: "@fixture/engine",
                  exports: { "./viewer": "./private/viewer-runtime.js" },
                }),
              }
            : {}),
          [DIST_DIFFS_VIEWER_RUNTIME]: "export {};\n",
          [DIST_RUNTIME_DIFFS_VIEWER_RUNTIME]: "export {};\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
        },
      });
      expect(resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp))).toEqual({
        shouldSync: false,
        reason: "clean",
      });
      await fs.rm(resolvePath(tmp, missingPath));
      const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));
      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
    });
  }

  it("does not require static asset outputs when runtime static assets are disabled", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIFFS_PACKAGE]:
          '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
        [DIFFS_VIEWER_RUNTIME_SOURCE]: "export {};\n",
        [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(
      createBuildRequirementDeps(tmp, { env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" } }),
    );

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("does not require static asset outputs when the declared source is absent", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIFFS_PACKAGE]:
          '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });
});
