import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { interceptPackageFileHashes } from "./package-update-integrity-hasher.test-support.js";
import { PackageIntegrityTimeoutError } from "./package-update-integrity.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import {
  expectInstallation,
  expectNoCalls,
  expectVersion,
  readText,
  retain,
} from "./package-update-swap.assertions.test-support.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
beforeEach(() => {
  base = dirs.make("package-swap-");
});
afterEach(() => vi.restoreAllMocks());

async function expectCompletion(
  transaction: PackageUpdateTransaction,
  activationVerified: boolean,
  exitCode?: number,
) {
  expect(await transaction.complete({ activationVerified }, () => {})).toEqual(
    exitCode === undefined ? undefined : expect.objectContaining({ exitCode }),
  );
}

const symlinkDirectory = (target: string, link: string) =>
  fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");

async function createLinkedPackageSwapFixture(rootDir: string, relative = false) {
  const fixture = await createPackageSwapFixture(rootDir);
  const checkout = path.join(rootDir, "checkout");
  await fs.rename(fixture.packageRoot, checkout);
  await fs.writeFile(path.join(checkout, "operator.txt"), "operator-owned checkout\n");
  // A linked checkout can reference dependencies outside the package root.
  await symlinkDirectory(rootDir, path.join(checkout, "external"));
  await symlinkDirectory(
    relative ? path.relative(path.dirname(fixture.packageRoot), checkout) : checkout,
    fixture.packageRoot,
  );
  return {
    ...fixture,
    checkout,
    target: await fs.readlink(fixture.packageRoot),
    linkIdentity: (await fs.lstat(fixture.packageRoot)).ino,
    checkoutIdentity: (await fs.stat(checkout)).ino,
  };
}

function afterLinkObservation(root: string, action: () => Promise<void> | void) {
  let observed = false;
  const readlink = fs.readlink.bind(fs);
  vi.spyOn(fs, "readlink").mockImplementation(async (...args) => {
    const target = await readlink(...args);
    if (String(args[0]) === root) {
      observed = true;
    }
    return target;
  });
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    if (String(args[0]) === root && observed) {
      await action();
    }
    return stat;
  });
}

type LinkedFixture = Awaited<ReturnType<typeof createLinkedPackageSwapFixture>>;
async function expectLink(fixture: LinkedFixture, root: string) {
  expect(await fs.lstat(root)).toMatchObject({ ino: fixture.linkIdentity });
  expect(await fs.readlink(root)).toBe(fixture.target);
  expect(await fs.stat(fixture.checkout)).toMatchObject({ ino: fixture.checkoutIdentity });
}

async function createLinkedGitSwapFixture(rootDir: string, relative = false) {
  const fixture = await createLinkedPackageSwapFixture(rootDir, relative);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", fixture.checkout, "-c", `core.hooksPath=${path.join(rootDir, "no-hooks")}`, ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "--quiet", "--template=");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const sha = git("rev-parse", "HEAD");
  const dist = path.join(fixture.checkout, "dist");
  await fs.mkdir(path.join(dist, "control-ui"));
  for (const [name, contents] of [
    ["entry.js", "export {};\n"],
    ["control-ui/index.html", "ready"],
    ["build-info.json", JSON.stringify({ commit: sha, buildId: "original-build" })],
    [".buildstamp", JSON.stringify({ head: sha })],
    [".runtime-postbuildstamp", JSON.stringify({ head: sha })],
  ] as const) {
    await fs.writeFile(path.join(dist, name), contents);
  }
  return { ...fixture, dist, sha };
}

describe("retained npm package integrity", () => {
  it
    .runIf(process.platform !== "win32")
    .each(process.platform === "darwin" ? [0o700, 0o755] : [0o777])(
    "preserves distinct launcher targets and permissions through rollback (mode %i)",
    async (mode) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const oldTarget = "../lib/node_modules/openclaw/old-launcher.mjs";
      const candidateTarget = "../lib/node_modules/openclaw/new-launcher.mjs";
      const stagedLauncher = path.join(params.stage.layout.binDir, "openclaw");
      for (const [root, shim, filename, contents, linkMode] of [
        [packageRoot, launcher, "old-launcher.mjs", "old launcher\n", mode],
        [
          params.stage.packageRoot,
          stagedLauncher,
          "new-launcher.mjs",
          "candidate launcher\n",
          mode === 0o700 ? 0o755 : 0o700,
        ],
      ] as const) {
        await fs.writeFile(path.join(root, filename), contents);
        await fs.chmod(path.join(root, filename), 0o751);
        await fs.unlink(shim);
        await fs.symlink(`../lib/node_modules/openclaw/${filename}`, shim);
        if (process.platform === "darwin") {
          await fs.lchmod(shim, linkMode);
        }
      }
      const original = await fs.lstat(launcher);
      const candidate = await fs.lstat(stagedLauncher);
      const transaction = await retain(params);
      expect(await fs.readlink(launcher)).toBe(candidateTarget);
      expect((await fs.lstat(launcher)).mode).toBe(candidate.mode);
      expect(await readText(launcher)).toBe("candidate launcher\n");
      expect((await fs.stat(launcher)).mode & 0o777).toBe(0o751);

      expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 0 });
      expect(await fs.readlink(launcher)).toBe(oldTarget);
      const restored = await fs.lstat(launcher);
      expect(restored).toMatchObject({ mode: original.mode, uid: original.uid, gid: original.gid });
      expect(await readText(launcher)).toBe("old launcher\n");
      expect((await fs.stat(launcher)).mode & 0o777).toBe(0o751);
      await expectCompletion(transaction, false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a staged relative npm link on its canonical checkout through activation and rollback",
    async () => {
      const fixture = await createPackageSwapFixture(base);
      const checkout = path.join(base, "candidate-checkout");
      const stagedRoot = fixture.params.stage.packageRoot;
      await fs.rename(stagedRoot, checkout);
      await fs.symlink(path.relative(path.dirname(stagedRoot), checkout), stagedRoot);
      const transaction = await retain(fixture.params);
      await expect(fs.realpath(fixture.packageRoot)).resolves.toBe(checkout);
      await expectInstallation(fixture.packageRoot, fixture.launcher, true);
      expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 0 });
      await expectVersion(checkout, "2.0.0");
      await expectVersion(fixture.packageRoot, "1.0.0");
    },
  );

  it("preserves the retained npm link if its executor is revoked after observation", async () => {
    const fixture = await createLinkedPackageSwapFixture(base);
    const transaction = await retain(fixture.params);
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("link retirement executor lost");
      }
    };
    afterLinkObservation(transaction.backupRoot, () => {
      current = false;
    });
    await expect(transaction.complete({ activationVerified: true }, assertCurrent)).rejects.toThrow(
      "link retirement executor lost",
    );
    await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toThrow(
      "link retirement executor lost",
    );
    await expectLink(fixture, transaction.backupRoot);
    await expectInstallation(fixture.packageRoot, fixture.launcher, true);
  });

  it("does not certify restoration of an absent old package", async () => {
    const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
    await fs.rm(packageRoot, { recursive: true });
    const transaction = await retain(params);
    expect(await transaction.rollback(() => {})).toMatchObject({
      exitCode: 1,
      activePackageRoot: null,
    });
    await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readText(launcher)).resolves.toBe("old launcher\n");
  });

  it("activates a package over an owned relative npm dev link", async () => {
    const fixture = await createLinkedPackageSwapFixture(base, true);
    const transaction = await retain(fixture.params);
    await expectInstallation(fixture.packageRoot, fixture.launcher, true);
    expect((await fs.lstat(transaction.backupRoot)).ino).toBe(fixture.linkIdentity);
    expect(await fs.readlink(transaction.backupRoot)).toBe(fixture.target);
    await fs.writeFile(path.join(fixture.checkout, "operator.txt"), "independent operator edit\n");
    await expectCompletion(transaction, true);
    await expect(fs.lstat(transaction.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(fixture.checkout)).ino).toBe(fixture.checkoutIdentity);
    expect(await readText(fixture.checkout, "operator.txt")).toBe("independent operator edit\n");
    await expectVersion(fixture.checkout, "1.0.0");
  });

  it("restores the owned npm link with verified Git recovery evidence", async () => {
    const fixture = await createLinkedGitSwapFixture(base, true);
    const transaction = await retain(fixture.params);
    await fs.writeFile(path.join(fixture.checkout, "operator.txt"), "local edit\n");
    await transaction.assertRollbackSafe?.();
    const rollback = await transaction.rollback(() => {});
    expect(rollback).toMatchObject({ exitCode: 0, activePackageRoot: fixture.packageRoot });
    expect(await fs.realpath(fixture.packageRoot)).toBe(fixture.checkout);
    await expectLink(fixture, fixture.packageRoot);
    expect(await readText(fixture.launcher)).toBe("old launcher\n");
    await expectCompletion(transaction, false);
    await expectCompletion(transaction, false);
    expect((await fs.readdir(fixture.globalRoot)).filter((name) => name.startsWith("."))).toEqual(
      [],
    );
    expect(await readText(fixture.checkout, "operator.txt")).toBe("local edit\n");
  });

  it.each(["before", "during"] as const)(
    "refuses checkout replacement %s verification",
    async (timing) => {
      const fixture = await createLinkedGitSwapFixture(base);
      const transaction = await retain(fixture.params);
      const moved = `${fixture.checkout}.original`;
      let replaced = false;
      if (timing === "before") {
        await fs.rename(fixture.checkout, moved);
        await symlinkDirectory(moved, fixture.checkout);
      } else {
        const stat = fs.stat.bind(fs);
        vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
          const observed = await stat(...args);
          if (String(args[0]) === fixture.checkout && !replaced) {
            replaced = true;
            await fs.rename(fixture.checkout, moved);
            await fs.cp(moved, fixture.checkout, { recursive: true, verbatimSymlinks: true });
          }
          return observed;
        });
      }
      await expect(transaction.assertRollbackSafe?.()).rejects.toThrow("Git runtime changed");
      if (timing === "before") {
        const rename = vi.spyOn(fs, "rename");
        expect(await transaction.rollback(() => {})).toMatchObject({
          exitCode: 1,
          activePackageRoot: fixture.packageRoot,
        });
        expect(rename).not.toHaveBeenCalled();
        await expectCompletion(transaction, false, 1);
        expect(await readText(fixture.checkout, "operator.txt")).toBe("operator-owned checkout\n");
      } else {
        expect(replaced).toBe(true);
      }
      await expectInstallation(fixture.packageRoot, fixture.launcher, true);
      expect((await fs.lstat(transaction.backupRoot)).ino).toBe(fixture.linkIdentity);
    },
  );

  it.each(["Git rebuild", "root link replacement"] as const)(
    "refuses %s during service preparation",
    async (change) => {
      const gitFixture =
        change === "Git rebuild" ? await createLinkedGitSwapFixture(base) : undefined;
      const fixture = gitFixture ?? (await createLinkedPackageSwapFixture(base));
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({
        ...fixture.params,
        onLiveMutation,
        beforeActivate: async () => {
          if (gitFixture) {
            await fs.writeFile(
              path.join(gitFixture.dist, "build-info.json"),
              JSON.stringify({ commit: gitFixture.sha, buildId: "replacement" }),
            );
          } else {
            await fs.rename(fixture.packageRoot, `${fixture.packageRoot}.original`);
            await symlinkDirectory(base, fixture.packageRoot);
          }
        },
      });
      expect(result).toMatchObject({ status: "failed", packageRollbackVerified: false });
      expect(onLiveMutation).not.toHaveBeenCalled();
      if (change === "Git rebuild") {
        expect(result.step.stderrTail).toContain("Git runtime changed");
        expect((await fs.lstat(fixture.packageRoot)).ino).toBe(fixture.linkIdentity);
      } else {
        expect(await fs.readlink(fixture.packageRoot)).toBe(base);
      }
      expect(await readText(fixture.launcher)).toBe("old launcher\n");
      expect(await readText(fixture.checkout, "operator.txt")).toBe("operator-owned checkout\n");
    },
  );

  it.each(["changed Git", "non-Git"] as const)(
    "rechecks %s recovery after failed verification",
    async (runtime) => {
      const fixture =
        runtime === "non-Git"
          ? await createLinkedPackageSwapFixture(base)
          : await createLinkedGitSwapFixture(base);
      const changed = runtime === "changed Git";
      const result = await swapStagedPackageInstall({
        ...fixture.params,
        postVerifyStep: async () => {
          if (changed) {
            await fs.unlink(path.join(fixture.checkout, "dist", "entry.js"));
          }
          return {
            name: "candidate verification",
            command: "verify candidate",
            cwd: fixture.packageRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "candidate rejected",
          };
        },
      });
      expect(result).toMatchObject({
        status: "failed",
        activePackageRoot: fixture.packageRoot,
        packageRollbackVerified: false,
        step: { exitCode: 1 },
      });
      if (changed) {
        await expectInstallation(fixture.packageRoot, fixture.launcher, true);
        expect(result.step.stderrTail).toContain("current package unchanged");
      } else {
        expect((await fs.lstat(fixture.packageRoot)).ino).toBe(fixture.linkIdentity);
        expect(await readText(fixture.launcher)).toBe("old launcher\n");
        expect(result.step.stderrTail).toContain(
          "Restored the npm package link and affected launchers",
        );
        expect(result.step.stderrTail).toContain(
          "external checkout runtime integrity is unverified",
        );
        expect(await fs.readlink(fixture.packageRoot)).toBe(fixture.target);
        expect(await readText(fixture.checkout, "operator.txt")).toBe("operator-owned checkout\n");
      }
    },
  );

  it("does not certify a linked runtime changed during restoration", async () => {
    const fixture = await createLinkedGitSwapFixture(base);
    const transaction = await retain(fixture.params);
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === transaction.backupRoot) {
        await fs.unlink(path.join(fixture.dist, "entry.js"));
      }
      return rename(...args);
    });
    expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 1 });
    expect((await fs.lstat(fixture.packageRoot)).ino).toBe(fixture.linkIdentity);
    expect(await readText(fixture.launcher)).toBe("old launcher\n");
    await expect(fs.stat(`${transaction.backupRoot}.candidate`)).resolves.toBeDefined();
    await expectCompletion(transaction, false, 1);
  });

  it("retains a directory substituted for the backup link after observation", async () => {
    const fixture = await createLinkedPackageSwapFixture(base);
    const transaction = await retain(fixture.params);
    let replaced = false;
    const replaceLink = async () => {
      replaced = true;
      await fs.rename(transaction.backupRoot, `${transaction.backupRoot}.original`);
      await fs.rename(fixture.checkout, transaction.backupRoot);
    };
    // The check sees the old link; removal must remain non-recursive afterward.
    afterLinkObservation(transaction.backupRoot, async () => {
      if (!replaced) {
        await replaceLink();
      }
    });
    expect(await transaction.complete({ activationVerified: true }, () => {})).toMatchObject({
      name: "package-backup-retention",
      exitCode: 1,
    });
    expect(replaced).toBe(true);
    const retained = await fs.lstat(transaction.backupRoot);
    expect(retained.isDirectory()).toBe(true);
    expect(retained.ino).toBe(fixture.checkoutIdentity);
    expect(await readText(transaction.backupRoot, "operator.txt")).toBe(
      "operator-owned checkout\n",
    );
    await expectInstallation(fixture.packageRoot, fixture.launcher, true);
  });

  it("retains an unexpected backup directory after nonretained activation", async () => {
    const fixture = await createLinkedPackageSwapFixture(base);
    let backupRoot = "";
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === fixture.packageRoot) {
        backupRoot = String(args[1]);
      }
      return rename(...args);
    });
    const result = await swapStagedPackageInstall({
      ...fixture.params,
      postVerifyStep: async () => {
        await rename(backupRoot, `${backupRoot}.original`);
        await rename(fixture.checkout, backupRoot);
        return { name: "verified", command: "verify", cwd: base, durationMs: 0, exitCode: 0 };
      },
    });
    expect(result.status).toBe("committed");
    expect(result.step.stdoutTail).toContain("Could not retire retained npm package link");
    expect((await fs.stat(backupRoot)).ino).toBe(fixture.checkoutIdentity);
    expect(await readText(backupRoot, "operator.txt")).toBe("operator-owned checkout\n");
    await expectInstallation(fixture.packageRoot, fixture.launcher, true);
  });

  it("refuses a replaced retained npm link before displacing the candidate", async () => {
    const fixture = await createLinkedPackageSwapFixture(base);
    const transaction = await retain(fixture.params);
    await fs.rename(transaction.backupRoot, `${transaction.backupRoot}.original`);
    await symlinkDirectory(fixture.target, transaction.backupRoot);
    const rollback = await transaction.rollback(() => {});
    expect(rollback).toMatchObject({ exitCode: 1, activePackageRoot: fixture.packageRoot });
    expect(rollback.stderrTail).toContain("retained package");
    expect(rollback.stderrTail).toContain(`changed at ${transaction.backupRoot}`);
    expect(rollback.stderrTail).toContain("before retrying recovery");
    await expectInstallation(fixture.packageRoot, fixture.launcher, true);
    expect(await readText(fixture.checkout, "operator.txt")).toBe("operator-owned checkout\n");
    await expectCompletion(transaction, false, 1);
  });

  it("retains a substituted backup directory when a new owner occupies the live path", async () => {
    const fixture = await createLinkedPackageSwapFixture(base);
    const rename = fs.rename.bind(fs);
    let movedRoot = "";
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === fixture.packageRoot && !movedRoot) {
        movedRoot = String(args[1]);
        await rename(fixture.packageRoot, `${fixture.packageRoot}.original`);
        await rename(fixture.checkout, fixture.packageRoot);
        await rename(...args);
        await fs.mkdir(fixture.packageRoot);
        await fs.writeFile(path.join(fixture.packageRoot, "new-owner.txt"), "preserve me");
        return;
      }
      return rename(...args);
    });
    const result = await swapStagedPackageInstall(fixture.params);
    expect(result).toMatchObject({
      status: "failed",
      packageRollbackVerified: false,
      activePackageRoot: null,
    });
    expect(movedRoot).not.toBe("");
    expect(result.step.stderrTail).toContain("link backup refused");
    const preservedRoot = movedRoot;
    expect((await fs.lstat(preservedRoot)).isDirectory()).toBe(true);
    expect((await fs.stat(preservedRoot)).ino).toBe(fixture.checkoutIdentity);
    expect(await readText(preservedRoot, "operator.txt")).toBe("operator-owned checkout\n");
    expect(result.step.stderrTail).toContain("moved entry retained");
    expect(await readText(fixture.packageRoot, "new-owner.txt")).toBe("preserve me");
    expect(await readText(fixture.launcher)).toBe("old launcher\n");
  });

  it.each(["inventory", "launcher"] as const)(
    "refuses changed %s before replacing the candidate",
    async (change) => {
      const { params, packageRoot, launcher, globalRoot } = await createPackageSwapFixture(base);
      const transaction = await retain(params);
      const backup = transaction.backupRoot;
      if (change === "inventory") {
        await fs.writeFile(path.join(backup, "unexpected.js"), "extra");
      } else {
        const shimBackup = (await fs.readdir(globalRoot)).find((name) =>
          name.startsWith(".openclaw.shim-backup-"),
        )!;
        await fs.writeFile(path.join(globalRoot, shimBackup, "openclaw"), "altered launcher\n");
      }
      const result = await transaction.rollback(() => {});
      expect(result).toMatchObject({ exitCode: 1, activePackageRoot: packageRoot });
      if (change !== "launcher") {
        expect(result.stderrTail).toContain(`retained package tree changed at ${backup}`);
        expect(result.stderrTail).toContain("before retrying recovery");
      }
      await expectInstallation(packageRoot, launcher, true);
      await expectCompletion(transaction, false, 1);
      await expect(fs.stat(backup)).resolves.toBeDefined();
    },
  );

  it("restores exact identity, internal links and launchers, then cleans up", async () => {
    const { params, packageRoot, launcher, globalRoot } = await createPackageSwapFixture(base);
    const entry = path.join(packageRoot, "dist", "index.js");
    const alias = `${launcher}.alias`;
    await fs.chmod(launcher, 0o751);
    await fs.link(launcher, alias);
    await fs.link(entry, path.join(packageRoot, "peer.js"));
    await fs.symlink("dist/index.js", path.join(packageRoot, "relative"));
    await fs.symlink(entry, path.join(packageRoot, "absolute"));
    await fs.symlink(`${entry}/missing`, path.join(packageRoot, "dangling"));
    const transaction = await retain(params);
    const retained = await fs.stat(transaction.backupRoot);
    expect(await transaction.rollback(() => {})).toMatchObject({
      exitCode: 0,
      activePackageRoot: packageRoot,
    });
    const restored = await fs.stat(packageRoot);
    expect([restored.dev, restored.ino]).toEqual([retained.dev, retained.ino]);
    expect((await fs.stat(entry)).ino).toBe((await fs.stat(path.join(packageRoot, "peer.js"))).ino);
    await expect(readText(launcher)).resolves.toBe("old launcher\n");
    await expect(readText(alias)).resolves.toBe("old launcher\n");
    if (process.platform !== "win32") {
      expect((await fs.stat(launcher)).mode & 0o777).toBe(0o751);
      expect((await fs.stat(alias)).mode & 0o777).toBe(0o751);
    }
    await expectCompletion(transaction, false);
    expect((await fs.readdir(globalRoot)).filter((name) => name.startsWith("."))).toEqual([]);
    expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 1 });
  });

  it("restores the candidate if exact rollback rename fails with EXDEV", async () => {
    const { transaction, packageRoot, launcher } = await createRetainedPackageSwap(base);
    const rename = fs.rename.bind(fs);
    const copy = vi.spyOn(fs, "cp");
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === transaction.backupRoot) {
        throw Object.assign(new Error("rollback rename denied"), { code: "EXDEV" });
      }
      return rename(...args);
    });
    expect(await transaction.rollback(() => {})).toMatchObject({
      exitCode: 1,
      activePackageRoot: packageRoot,
    });
    expect(copy).not.toHaveBeenCalled();
    await expectInstallation(packageRoot, launcher, true);
    await expect(fs.stat(transaction.backupRoot)).resolves.toBeDefined();
    await expectCompletion(transaction, true, 1);
  });

  it.each([
    {
      shape: "sibling dependency link",
      cause: "Package rollback symlink leaves the retained tree",
    },
    { shape: "unavailable inode", cause: "Package rollback filesystem identity is unavailable" },
    { shape: "timed-out scan", cause: "Package rollback verification timed out" },
  ] as const)(
    "records the baseline scan failure for $shape before service preparation or live mutation",
    async ({ shape, cause }) => {
      const { params, packageRoot, globalRoot, launcher } = await createPackageSwapFixture(base);
      let timedOut = false;
      if (shape === "sibling dependency link") {
        const dependency = path.join(globalRoot, "fixture-dependency");
        await fs.mkdir(dependency);
        await fs.writeFile(path.join(dependency, "index.js"), "export default 42;\n");
        await fs.mkdir(path.join(packageRoot, "node_modules"));
        const link = path.join(packageRoot, "node_modules", "fixture-dependency");
        await fs.symlink("../../fixture-dependency", link);
        expect(await fs.realpath(link)).toBe(await fs.realpath(dependency));
      }
      if (shape === "unavailable inode" || shape === "timed-out scan") {
        const lstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if (timedOut && String(args[0]) === packageRoot) {
            throw new Error("identity fallback unavailable");
          }
          const stat = await lstat(...args);
          if (shape === "unavailable inode" && typeof stat.ino === "bigint") {
            Object.assign(stat, { ino: 0n });
          }
          return stat;
        });
      }
      if (shape === "timed-out scan") {
        interceptPackageFileHashes(async () => {
          timedOut = true;
          throw new PackageIntegrityTimeoutError(40);
        });
      }
      const beforeActivate = vi.fn();
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({
        ...params,
        beforeActivate,
        onLiveMutation,
      });
      expect(timedOut).toBe(shape === "timed-out scan");
      expect(result.status).toBe("failed");
      expect(result.step.stderrTail).not.toContain("package tree changed");
      expect(result.step.stderrTail).not.toContain("Installation recovery is unverified");
      const steps = updateRunStepsFromResultStep(result.step);
      expect(steps[0]).toMatchObject({
        detail: expect.stringContaining("Baseline package scan failed"),
        failureFacts: [
          {
            check: "package-swap",
            code: "baseline-scan-failed",
            message: expect.stringContaining(cause),
          },
        ],
      });
      const report = await prepareUpdateFailureReport(
        {
          attemptId: "baseline-failure",
          result: { mode: "npm", status: "error", steps: [], durationMs: 0 },
          recordedRun: { runId: "baseline-failure", steps },
        },
        { env: {}, stateDir: base },
      );
      expect(report.body).toContain("baseline-scan-failed");
      if (shape === "timed-out scan") {
        expect(report.body).toContain(cause);
      } else {
        expect(report.body).not.toContain(cause);
        expect(report.body).toContain("[redacted-diagnostic]");
      }
      expect(report.body).not.toContain("identity fallback unavailable");
      expect(report.body).not.toContain(base);
      expect(result).toMatchObject({ packageRollbackVerified: false });
      expectNoCalls(beforeActivate, onLiveMutation);
      await expectInstallation(packageRoot, launcher);
    },
  );
});
