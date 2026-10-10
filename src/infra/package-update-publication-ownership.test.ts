import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as commandExec from "../process/exec.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import { assertNoPendingPackageActivation } from "./package-update-activation.js";
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

const fixtures = createPackageActivationLifetimeFixture();
let root: string;
beforeEach(() => {
  ({ root } = fixtures.setup());
  const state = path.join(root, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
});
afterEach(async () => {
  try {
    await fixtures.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it
  .skipIf(process.platform === "win32")
  .each([
    "parents",
    "package",
    "launcher",
    "orphan launcher",
    "source launcher",
    "package link",
    "external source",
    "launcher suffix",
    "unpublished launcher",
    "FreeBSD launcher",
  ] as const)("admits publication by object ownership before candidate validation: %s", (foreign) =>
  fixtures.lifetime.run(async () => {
    const f = await createPackageSwapFixture(root);
    const launcher =
      foreign === "launcher suffix"
        ? `${f.launcher}.sh`
        : foreign === "unpublished launcher"
          ? `${f.launcher}.backup`
          : f.launcher;
    if (launcher !== f.launcher) {
      await fsp.copyFile(f.launcher, launcher);
    }
    if (foreign === "FreeBSD launcher") {
      vi.spyOn(commandExec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
    }
    const source = path.join(root, "source");
    if (foreign === "orphan launcher") {
      await fsp.rm(f.packageRoot, { recursive: true });
    } else if (
      foreign === "source launcher" ||
      foreign === "package link" ||
      foreign === "external source"
    ) {
      await fsp.rename(f.packageRoot, source);
      await fsp.symlink(source, f.packageRoot);
    }
    const uid = process.getuid!();
    const foreignUid = uid + 1001;
    const foreignPaths =
      foreign === "parents"
        ? [f.globalRoot, path.dirname(f.launcher)]
        : [
            foreign === "package" || foreign === "package link"
              ? f.packageRoot
              : foreign === "external source"
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
      if (
        foreign === "parents" ||
        foreign === "unpublished launcher" ||
        foreign === "external source"
      ) {
        expect(result.failedStep, JSON.stringify({ phases, failed: result.failedStep })).toBeNull();
        expect(phases).toEqual(["install", "validate", "activate"]);
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
        expect(result.afterVersion).toBe("2.0.0");
        if (foreign === "unpublished launcher") {
          expect(fs.readFileSync(launcher, "utf8")).toBe("old launcher\n");
        }
        if (foreign === "external source") {
          expect(fs.readFileSync(path.join(source, "package.json"), "utf8")).toContain(
            '"version":"1.0.0"',
          );
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
        expect(fs.readFileSync(launcher, "utf8")).toBe("old launcher\n");
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
      const f = await createPackageSwapFixture(root);
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
          expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
            '"version":"1.0.0"',
          );
          return;
        }
        if (outcome === "rollback") {
          expect(publicationFailed).toBe(true);
          expect(result.status).toBe("failed");
          expect(result.step.stderrTail).toContain("fixture publication acknowledgement failed");
          expect(await transaction!.rollback(fence.assertCurrent)).toMatchObject({ exitCode: 0 });
          expect(fs.readlinkSync(f.launcher)).toBe(target);
          expect(fs.lstatSync(f.launcher).gid).toBe(process.getegid!());
          expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
            '"version":"1.0.0"',
          );
        } else {
          expect(result.status, result.step.stderrTail ?? "").toBe("committed");
          expect(fs.readFileSync(f.launcher, "utf8")).toContain('"version":"2.0.0"');
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
