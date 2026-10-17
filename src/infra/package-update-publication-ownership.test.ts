import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as commandExec from "../process/exec.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import { assertNoPendingPackageActivation } from "./package-update-activation.js";
import {
  createPublicationTestFixture,
  readPublicationText as read,
} from "./package-update-publication.test-support.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmUpdateOptions,
  packageUpdateStepResult,
  stagedNpmPrefix,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { pkgQueryResult } from "./update-freebsd-pkg-ownership.test-support.js";

const fixtures = createPublicationTestFixture();

type OwnershipScenario = {
  suffix?: string;
  root?: "absent" | "link";
  owner?: "parents" | "package" | "source";
  accepted?: boolean;
};
const ownershipScenarios: Array<[string, OwnershipScenario]> = [
  ["parents", { owner: "parents", accepted: true }],
  ["package", { owner: "package" }],
  ["launcher", {}],
  ["orphan launcher", { root: "absent" }],
  ["source launcher", { root: "link" }],
  ["package link", { root: "link", owner: "package" }],
  ["external source", { root: "link", owner: "source", accepted: true }],
  ["launcher suffix", { suffix: ".sh" }],
  ["unpublished launcher", { suffix: ".backup", accepted: true }],
  ["FreeBSD launcher", {}],
];
it.skipIf(process.platform === "win32").each(ownershipScenarios)(
  "admits publication by object ownership before candidate validation: %s",
  (foreign, scenario) =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(fixtures.root);
      const launcher = `${f.launcher}${scenario.suffix ?? ""}`;
      if (launcher !== f.launcher) {
        await fsp.copyFile(f.launcher, launcher);
      }
      if (foreign === "FreeBSD launcher") {
        vi.spyOn(commandExec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
      }
      const source = path.join(fixtures.root, "source");
      if (scenario.root === "absent") {
        await fsp.rm(f.packageRoot, { recursive: true });
      } else if (scenario.root === "link") {
        await fsp.rename(f.packageRoot, source);
        await fsp.symlink(source, f.packageRoot);
      }
      const uid = process.getuid!();
      const foreignUid = uid + 1001;
      const foreignPaths =
        scenario.owner === "parents"
          ? [f.globalRoot, path.dirname(f.launcher)]
          : [
              scenario.owner === "package"
                ? f.packageRoot
                : scenario.owner === "source"
                  ? source
                  : launcher,
            ];
      // CI cannot chown to another user; retain real filesystem/publication behavior.
      const lstat = fs.lstatSync;
      vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        if (stat && foreignPaths.includes(String(args[0]))) {
          Object.defineProperty(stat, "uid", {
            value: typeof stat.uid === "bigint" ? BigInt(foreignUid) : foreignUid,
          });
        }
        return stat;
      });
      const phases: string[] = [];
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        let transaction: PackageUpdateTransaction | undefined;
        const update = () =>
          runGlobalPackageUpdateSteps({
            ...createNpmUpdateOptions(f.globalRoot),
            runStep: async (step) => {
              phases.push("install");
              const prefix = stagedNpmPrefix(step.argv);
              const candidate = path.join(prefix, "lib/node_modules/openclaw");
              await writePackageRoot(candidate, "2.0.0");
              await fixtures.writePostCoreCapability(candidate);
              await writePackageDistInventory(candidate);
              await fsp.mkdir(path.join(prefix, "bin"), { recursive: true });
              await fsp.writeFile(path.join(prefix, "bin/openclaw"), "candidate launcher\n");
              if (foreign === "launcher suffix") {
                await fsp.writeFile(path.join(prefix, "bin/openclaw.sh"), "candidate launcher\n");
              }
              return packageUpdateStepResult(step);
            },
            validateCandidate: async () => {
              phases.push("validate");
              return [];
            },
            beforeActivate: async () => {
              phases.push("activate");
            },
            getActivation: () => ({
              fence,
              runtime: packageActivationRuntimeForTest(),
              onPrepared: () => {},
            }),
            onTransaction: (issued) => {
              transaction = issued;
            },
          });
        const result =
          foreign === "FreeBSD launcher"
            ? await withMockedPlatform("freebsd", update)
            : await update();
        if (scenario.accepted) {
          expect(
            result.failedStep,
            JSON.stringify({ phases, failed: result.failedStep }),
          ).toBeNull();
          expect(phases).toEqual(["install", "validate", "activate"]);
          expect(read(f.launcher)).toBe("candidate launcher\n");
          expect(result.afterVersion).toBe("2.0.0");
          if (foreign === "unpublished launcher") {
            expect(read(launcher)).toBe("old launcher\n");
          }
          if (foreign === "external source") {
            expect(read(source, "package.json")).toContain('"version":"1.0.0"');
          }
          await transaction!.complete({ activationVerified: true }, fence.assertCurrent);
          expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
        } else {
          expect(
            result.failedStep,
            JSON.stringify({ phases, failed: result.failedStep }),
          ).toMatchObject({
            name: "package-publication-admission",
            exitCode: 1,
          });
          expect(result.failedStep?.stderrTail).toContain(foreignPaths[0]);
          expect(result.failedStep?.stderrTail).toContain(`owner UID ${foreignUid}`);
          expect(result.failedStep?.stderrTail).toContain(`expected UID ${uid}`);
          expect(phases).toEqual(foreign === "launcher suffix" ? ["install"] : []);
          expect(transaction).toBeUndefined();
          expect(read(launcher)).toBe("old launcher\n");
          expect(result.recovery).toEqual(
            foreign === "orphan launcher"
              ? { serviceRestartSafe: false, reason: "runtime-verification-failed" }
              : { serviceRestartSafe: true, version: "1.0.0" },
          );
        }
      });
    }),
);

it
  .runIf(process.platform === "darwin")
  .each(["commit", "rollback", "foreign", "preserve"] as const)(
  "settles a non-root launcher ownership mismatch: %s",
  (outcome) =>
    fixtures.lifetime.run(async () => {
      expect(process.geteuid!()).not.toBe(0);
      const gid = process.getgroups!().find((group) => group !== process.getegid!());
      expect(gid).toBeDefined();
      const f = await createPackageSwapFixture(fixtures.root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      const target = "../lib/node_modules/openclaw/package.json";
      const liveGid = outcome === "preserve" ? process.getegid!() : gid!;
      fs.unlinkSync(f.launcher);
      fs.symlinkSync(target, f.launcher);
      fs.lchownSync(f.launcher, process.geteuid!(), liveGid);
      fs.chownSync(path.dirname(f.launcher), process.geteuid!(), gid!);
      const candidateLauncher = path.join(f.params.stage.layout.binDir, "openclaw");
      fs.unlinkSync(candidateLauncher);
      fs.symlinkSync(target, candidateLauncher);
      fs.lchownSync(candidateLauncher, process.geteuid!(), gid!);
      const original = fs.lstatSync(f.launcher);
      const lchown = fsp.lchown.bind(fsp);
      let denied = 0;
      vi.spyOn(fsp, "lchown").mockImplementation(async (file, uid, group) => {
        if (group === gid && outcome !== "preserve") {
          denied++;
          throw Object.assign(new Error("fixture cannot preserve launcher group"), {
            code: "EPERM",
          });
        }
        return lchown(file, uid, group);
      });
      const rename = fsp.rename.bind(fsp);
      let publicationFailed = false;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (outcome === "rollback" && to === f.launcher && !publicationFailed) {
          publicationFailed = true;
          throw Object.assign(new Error("fixture publication acknowledgement failed"), {
            code: "EIO",
          });
        }
      });
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        let transaction: PackageUpdateTransaction | undefined;
        const result = await swapStagedPackageInstall({
          ...f.params,
          activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
          beforeActivate: async () => {
            expect(fs.lstatSync(f.launcher)).toMatchObject({ ino: original.ino, gid: liveGid });
            if (outcome === "foreign") {
              fs.renameSync(f.launcher, `${f.launcher}.original`);
              fs.symlinkSync("foreign-target", f.launcher);
            }
          },
          onTransaction: (issued) => {
            transaction = issued;
          },
        });
        if (outcome !== "preserve") {
          expect(denied).toBeGreaterThan(0);
        }
        if (outcome === "foreign") {
          expect(result.status).toBe("failed");
          expect(result.step.stderrTail).toContain("outside its publication intent");
          expect(fs.readlinkSync(f.launcher)).toBe("foreign-target");
          expect(read(f.packageRoot, "package.json")).toContain('"version":"1.0.0"');
          return;
        }
        if (outcome === "rollback") {
          expect(publicationFailed).toBe(true);
          expect(result.status).toBe("failed");
          expect(result.step.stderrTail).toContain("fixture publication acknowledgement failed");
          expect(await transaction!.rollback(fence.assertCurrent)).toMatchObject({ exitCode: 0 });
          expect(fs.readlinkSync(f.launcher)).toBe(target);
          expect(fs.lstatSync(f.launcher).gid).toBe(process.getegid!());
          expect(read(f.packageRoot, "package.json")).toContain('"version":"1.0.0"');
        } else {
          expect(result.status, result.step.stderrTail ?? "").toBe("committed");
          expect(read(f.launcher)).toContain('"version":"2.0.0"');
          expect(fs.lstatSync(f.launcher).gid).toBe(process.getegid!());
        }
        await transaction!.complete(
          { activationVerified: outcome !== "rollback" },
          fence.assertCurrent,
        );
        expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      });
    }),
);
