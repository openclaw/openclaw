import fs from "node:fs";
import path from "node:path";
import { packageReleaseGlobalRoot } from "./package-release-slot-path.js";
import { createPackageReleasePrefix } from "./package-release-slot.js";
import type { createPackageReleasePrefixFixture } from "./package-release-slot.test-support.js";
import { createNpmTarget } from "./package-update-steps.test-support.js";
import type { StagedPackageSwapParams } from "./package-update-swap-contract.js";

type ReleaseFixture = ReturnType<typeof createPackageReleasePrefixFixture>;

/** A verified candidate installed into its own release prefix, as npm leaves it. */
export async function stagePackageRelease(
  fixture: ReleaseFixture,
  version: string,
  build = `build-${version}`,
): Promise<StagedPackageSwapParams> {
  const prefix = await createPackageReleasePrefix(fixture.prefix, version);
  const globalRoot = packageReleaseGlobalRoot(prefix);
  const packageRoot = path.join(globalRoot, "openclaw");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
  fs.writeFileSync(path.join(packageRoot, "openclaw.mjs"), "export {};\n");
  fs.writeFileSync(
    path.join(packageRoot, "dist", "build-info.json"),
    JSON.stringify({ buildId: build }),
  );
  fs.mkdirSync(path.join(prefix, "bin"));
  fs.symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", path.join(prefix, "bin", "openclaw"));
  return {
    installTarget: createNpmTarget(fixture.globalRoot),
    packageName: "openclaw",
    stage: {
      prefix,
      layout: { prefix, globalRoot, binDir: path.join(prefix, "bin") },
      packageRoot,
      installTarget: createNpmTarget(globalRoot),
      release: { slot: fixture.slot, prefix: fixture.prefix },
    },
  };
}
