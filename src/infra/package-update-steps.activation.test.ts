import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import {
  PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import {
  completePackageLifecycle,
  runBundledPluginPostinstall,
} from "../../scripts/postinstall-bundled-plugins.mjs";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";

type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];

describe("package update activation metadata", () => {
  it("promotes a no-restart staged package after content verification", async () => {
    await withTestDir({ prefix: "openclaw-package-update-manual-activation-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      let stagedPackageRoot: string | undefined;

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        env: { OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0" },
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
          if (name === "global update") {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
            await writePackageRoot(stagedPackageRoot, "2.0.0");
            await fs.writeFile(
              path.join(stagedPackageRoot, "dist", "build-info.json"),
              `${JSON.stringify({ buildId: "candidate" })}\n`,
            );
            await fs.mkdir(path.join(stagedPackageRoot, "scripts", "lib"), { recursive: true });
            await Promise.all([
              fs.writeFile(
                path.join(stagedPackageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
                "export {};\n",
              ),
              fs.writeFile(
                path.join(stagedPackageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
                "export {};\n",
              ),
              fs.writeFile(
                path.join(stagedPackageRoot, PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH),
                "export {};\n",
              ),
              fs.writeFile(
                path.join(stagedPackageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
                "pending\n",
              ),
            ]);
            await writePackageDistInventory(stagedPackageRoot);
          } else if (name.endsWith("package postinstall")) {
            if (!stagedPackageRoot) {
              throw new Error("missing staged package root");
            }
            runBundledPluginPostinstall({ packageRoot: stagedPackageRoot, env });
            expect(completePackageLifecycle({ packageRoot: stagedPackageRoot })).toBe(true);
          }
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        },
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "npm package preinstall",
        "npm package postinstall",
        "global install swap",
      ]);
      await expect(
        fs.readFile(path.join(packageRoot, "dist", "build-info.json"), "utf8"),
      ).resolves.toContain('"activation": "manual"');
    });
  });
});
