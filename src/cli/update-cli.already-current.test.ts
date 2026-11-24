import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { VERSION } from "../version.js";
import * as proof from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as modules from "./update-cli-modules.test-support.js";
import { writeNpmPackageInstall } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const setup = createUpdateCliFixture();
  const { updateCommand } = modules;

  it("completes an equal-version Git-to-package switch", async () => {
    const { nodeModules, pkgRoot } = await setup.setupInstalledPackageRoot(
      setup.createCaseDir("openclaw-git-to-package-same-version"),
      VERSION,
    );
    await fs.writeFile(path.join(pkgRoot, "dist", "index.js"), "git runtime\n");
    await writePackageDistInventory(pkgRoot);
    setup.mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] !== "npm" || argv[1] !== "i") {
        return;
      }
      await writeNpmPackageInstall(argv, pkgRoot, VERSION);
      const stagePrefix = proof.requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
      const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
      await fs.writeFile(path.join(stageRoot, "dist", "index.js"), "package runtime\n");
      await writePackageDistInventory(stageRoot);
    });
    setup.mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    vi.mocked(modules.resolveUpdateInstallKind).mockResolvedValue("git");
    vi.mocked(modules.resolveUpdateInstallIdentity).mockResolvedValue({
      installKind: "git",
      git: { tag: `v${VERSION}`, branch: "main" },
    });
    mocks.readPackageVersion.mockImplementation(async (root: string) => {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
        version: string;
      };
      return manifest.version;
    });
    setup.primeNpmChannelTag("latest", VERSION);
    vi.mocked(modules.readConfigFileSnapshot).mockResolvedValue(
      setup.configSnapshot({ update: { channel: "dev" } }),
    );

    await updateCommand({ channel: "stable", yes: true, restart: false, json: true });

    proof.expectPackageInstallSpec(`openclaw@${VERSION}`);
    expect(mocks.candidateCheck).toHaveBeenCalled();
    await expect(fs.readFile(path.join(pkgRoot, "dist", "index.js"), "utf8")).resolves.toBe(
      "package runtime\n",
    );
    expect(proof.lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("stable");
    const result = proof.lastWriteJsonCall() as UpdateRunResult;
    expect(result).toMatchObject({
      status: "ok",
      mode: "npm",
      root: pkgRoot,
    });
    expect(result.reason).toBeUndefined();
  });
});
