import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import * as updateGlobal from "../../infra/update-global.js";
import { finishUpdateRun } from "../../infra/update-run-ledger.js";
import * as shared from "./shared.js";
import * as execution from "./update-command-execution.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const { fixture, dirs } = installFreshUpdateFixture();

it.each([false, true])(
  "preserves local files through real fresh-profile staging (replay=%s)",
  async (reapplyLocalOverrides) => {
    const base = dirs.make("fresh-artifact-overrides-");
    const target = createNpmTarget(path.join(base, "prefix", "lib", "node_modules"));
    const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    const [major = 0, minor = 0] = npmVersion.split(".").map(Number);
    target.npmOwner = {
      version: npmVersion,
      lifecyclePolicy:
        major >= 12
          ? "allow-scripts"
          : major === 11 && minor >= 16
            ? "allow-scripts-advisory"
            : "unflagged",
    };
    fixture.root = target.packageRoot!;
    await writePackageRoot(fixture.root, "2026.9.3");
    const relativeFile = "dist/local-reapply-probe.txt";
    const marker = "operator-owned override\n";
    fs.writeFileSync(path.join(fixture.root, relativeFile), marker, { mode: 0o600 });
    const candidate = path.join(base, "package");
    await writePackageRoot(candidate, "2026.9.4");
    fs.writeFileSync(
      path.join(candidate, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.4",
        type: "module",
        openclaw: { schemaVersions: { state: 17, agent: 20 } },
      }),
    );
    await writePackageDistInventory(candidate);
    const artifact = path.join(base, "candidate.tgz");
    execFileSync("tar", ["-czf", artifact, "-C", base, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
    vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockResolvedValue(target);
    vi.mocked(updateGlobal.createGlobalInstallEnv).mockResolvedValue({
      ...process.env,
      npm_config_userconfig: path.join(base, "empty.npmrc"),
      npm_config_globalconfig: path.join(base, "empty-global.npmrc"),
      npm_config_cache: path.join(base, "npm-cache"),
    });
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockRestore();
    const prepare = vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation()!;
    vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (opts) => ({
      ...(await prepare(opts)),
      timeoutMs: 30_000,
    }));
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: { nodeRunner: process.execPath },
    });
    vi.spyOn(execution, "executeMutableUpdate").mockImplementation(async (params) => {
      // Keep real admission, staging, npm, replay and backup ownership; this synthetic
      // package has no Gateway lifecycle or post-core plugin convergence to finalize.
      assert(params.stagedPackage);
      const run = params.opts.run;
      assert(run);
      const assertCurrent = () => run.executorFence!.assertCurrent();
      let transaction: PackageUpdateTransaction | undefined;
      const result = await params.stagedPackage.run({
        root: fixture.root,
        installKind: "package",
        tag: artifact,
        timeoutMs: 30_000,
        startedAt: params.startedAt,
        jsonMode: true,
        progress: params.progress,
        nodeRunner: process.execPath,
        managedServiceEnv: run.env,
        reapplyLocalOverrides: params.opts.reapplyLocalOverrides,
        validateCandidate: async () => [],
        beforeActivate: async () => assertCurrent(),
        onTransaction: (value) => {
          transaction = value;
        },
      });
      expect(result.status).toBe("ok");
      assert(transaction);
      await transaction.complete({ activationVerified: true }, assertCurrent);
      expect(fs.existsSync(path.join(fixture.root, relativeFile))).toBe(reapplyLocalOverrides);
      if (reapplyLocalOverrides) {
        expect(fs.readFileSync(path.join(fixture.root, relativeFile), "utf8")).toBe(marker);
        expect(result.localOverrides?.warnings).toEqual([]);
      } else {
        expect(result.localOverrides?.warnings).toEqual([
          expect.stringContaining("were not reapplied"),
        ]);
      }
      expect(result.localOverrides).toMatchObject({
        status: reapplyLocalOverrides ? "applied" : "preserved",
        added: 1,
        applied: reapplyLocalOverrides ? 1 : 0,
        conflicts: [],
      });
      const recoveryDir = result.localOverrides!.recoveryDir!;
      expect(fs.readFileSync(path.join(recoveryDir, "files", relativeFile), "utf8")).toBe(marker);
      expect(
        result.steps.some(
          (step) =>
            step.name === "local package overrides" && step.advisory?.message.includes(recoveryDir),
        ),
      ).toBe(true);
      finishUpdateRun(run.runId, { status: "succeeded" }, { env: run.env });
      return null;
    });

    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    await updateCommand({
      tag: `file:${artifact}`,
      yes: true,
      json: true,
      restart: false,
      reapplyLocalOverrides,
    });
  },
  60_000,
);
