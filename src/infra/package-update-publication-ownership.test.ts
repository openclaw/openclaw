import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import * as commandExec from "../process/exec.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { assertNoPendingPackageActivation } from "./package-update-activation.js";
import {
  createPublicationTestFixture,
  withPublicationFence,
  publicationActivation,
  runPublicationSwap,
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
  fixtures.withFixture(async (f, foreign: string, scenario: OwnershipScenario) => {
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
    const foreignPaths = {
      parents: [f.globalRoot, path.dirname(f.launcher)],
      package: [f.packageRoot],
      source: [source],
      launcher: [launcher],
    }[scenario.owner ?? "launcher"];
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
    await withPublicationFence(f.packageRoot, async (fence) => {
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
          getActivation: () => publicationActivation(fence),
          onTransaction: (issued) => {
            transaction = issued;
          },
        });
      const result =
        foreign === "FreeBSD launcher"
          ? await withMockedPlatform("freebsd", update)
          : await update();
      const failure = expect(
        result.failedStep,
        JSON.stringify({ phases, failed: result.failedStep }),
      );
      if (scenario.accepted) {
        failure.toBeNull();
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
        failure.toMatchObject({
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
  }, false),
);

it
  .runIf(process.platform === "darwin")
  .each(["commit", "rollback", "foreign", "preserve"] as const)(
  "settles a non-root launcher ownership mismatch: %s",
  fixtures.withFixture(async (f, outcome: string) => {
    expect(process.geteuid!()).not.toBe(0);
    const gid = process.getgroups!().find((group) => group !== process.getegid!());
    expect(gid).toBeDefined();
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
    await withPublicationFence(f.packageRoot, async (fence) => {
      const { result, transaction } = await runPublicationSwap(f, fence, {
        beforeActivate: async () => {
          expect(fs.lstatSync(f.launcher)).toMatchObject({ ino: original.ino, gid: liveGid });
          if (outcome === "foreign") {
            fs.renameSync(f.launcher, `${f.launcher}.original`);
            fs.symlinkSync("foreign-target", f.launcher);
          }
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
        expect(read(f.packageRoot, "package.json")).toContain('"version":"1.0.0"');
      } else {
        expect(result.status, result.step.stderrTail ?? "").toBe("committed");
        expect(read(f.launcher)).toContain('"version":"2.0.0"');
      }
      expect(fs.lstatSync(f.launcher).gid).toBe(process.getegid!());
      await transaction!.complete(
        { activationVerified: outcome !== "rollback" },
        fence.assertCurrent,
      );
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    });
  }),
);
