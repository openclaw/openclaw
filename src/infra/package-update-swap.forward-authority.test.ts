import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPnpmTarget, writePackageRoot } from "./package-update-steps.test-support.js";
import {
  captureSwap,
  expectInstallation,
  expectVersion,
  readText,
} from "./package-update-swap.assertions.test-support.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { prepareNativePackageStage } from "./update-native-package-stage.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("stops fallback publication after local override work loses forward authority", async () => {
  const base = dirs.make("swap-override-authority-");
  const f = await createPackageSwapFixture(base);
  await fs.writeFile(path.join(f.packageRoot, "dist/index.js"), "operator edit\n");
  let current = true;
  const { result, transaction } = await captureSwap({
    ...f.params,
    assertCurrent: () => {
      if (!current) {
        throw new Error("forward authority lost during override work");
      }
    },
    localOverrides: {
      reapply: false,
      env: { HOME: base, OPENCLAW_STATE_DIR: path.join(base, "state") },
    },
    onLocalOverrides: () => {
      current = false;
    },
  });
  expect(current).toBe(false);
  expect(result).toMatchObject({ status: "failed", activePackageRoot: null });
  await expect(fs.lstat(f.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await expectVersion(transaction.backupRoot, "1.0.0");
  expect(await readText(f.launcher)).toBe("old launcher\n");
  expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 0 });
  await expectInstallation(f.packageRoot, f.launcher);
  expect(await readText(f.packageRoot, "dist/index.js")).toBe("operator edit\n");
});

it("stops subsequent launcher publication while independent rollback remains authorized", async () => {
  const f = await createPackageSwapFixture(dirs.make("swap-launcher-authority-"));
  const second = `${f.launcher}.cmd`;
  await fs.writeFile(second, "old command launcher\n");
  await fs.writeFile(path.join(f.params.stage.layout.binDir, "openclaw.cmd"), "new command\n");
  let current = true;
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (String(to) === f.launcher) {
      current = false;
    }
  });
  const { result, transaction } = await captureSwap({
    ...f.params,
    assertCurrent: () => {
      if (!current) {
        throw new Error("forward launcher authority lost");
      }
    },
  });
  expect(result).toMatchObject({ status: "failed", activePackageRoot: f.packageRoot });
  expect(await readText(f.launcher)).toBe("candidate launcher\n");
  expect(await readText(second)).toBe("old command launcher\n");
  expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 0 });
  await expectInstallation(f.packageRoot, f.launcher);
  expect(await readText(second)).toBe("old command launcher\n");
});

it.runIf(process.platform !== "win32")(
  "records EXDEV activation before a post-publication refusal and retains its source",
  async () => {
    const f = await createPackageSwapFixture(dirs.make("swap-copy-authority-"));
    const rename = fs.rename.bind(fs);
    let current = true;
    let copied = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === f.params.stage.packageRoot && String(to) === f.packageRoot) {
        throw Object.assign(new Error("cross-device stage"), { code: "EXDEV" });
      }
      await rename(from, to);
      if (String(to) === f.packageRoot && String(from).includes(".fs-safe-move-")) {
        copied = true;
        current = false;
      }
    });
    const { result, transaction } = await captureSwap({
      ...f.params,
      assertCurrent: () => {
        if (!current) {
          throw new Error("forward copy authority lost");
        }
      },
    });
    expect(copied).toBe(true);
    expect(result).toMatchObject({ status: "failed", activePackageRoot: f.packageRoot });
    await expectVersion(f.packageRoot, "2.0.0");
    await expectVersion(f.params.stage.packageRoot, "2.0.0");
    expect(await readText(f.launcher)).toBe("old launcher\n");
    expect(await transaction.rollback(() => {})).toMatchObject({ exitCode: 0 });
    await expectInstallation(f.packageRoot, f.launcher);
  },
);

it.runIf(process.platform !== "win32")(
  "registers a published native backup even when its copy cleanup loses authority",
  async () => {
    const base = dirs.make("swap-native-backup-authority-");
    const project = path.join(base, "global");
    const globalRoot = path.join(project, "v11");
    const packageRoot = path.join(globalRoot, "group/node_modules/openclaw");
    const binDir = path.join(base, "bin");
    await writePackageRoot(packageRoot, "1.0.0");
    await fs.mkdir(binDir);
    const installTarget = createPnpmTarget(globalRoot, packageRoot);
    const native = await prepareNativePackageStage({
      installTarget,
      packageName: "openclaw",
      installSpec: "openclaw@2.0.0",
      globalBinDir: binDir,
      env: {},
    });
    expect(native).toBeDefined();
    if (!native) {
      throw new Error("missing native stage");
    }
    const candidate = path.join(native.projectRoot, path.relative(project, packageRoot));
    await writePackageRoot(candidate, "2.0.0");
    let current = true;
    let published = false;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === native.liveProjectRoot) {
        throw Object.assign(new Error("cross-device backup"), { code: "EXDEV" });
      }
      await rename(from, to);
      if (String(from).includes(".fs-safe-move-") && String(to).includes(".package-backup-")) {
        published = true;
        current = false;
      }
    });
    const { result, transaction } = await captureSwap({
      installTarget,
      packageName: "openclaw",
      stage: {
        prefix: native.projectRoot,
        layout: {
          prefix: native.projectRoot,
          globalRoot: native.globalRoot,
          binDir: native.binDir,
        },
        packageRoot: candidate,
        installTarget: createPnpmTarget(native.globalRoot, candidate),
        native,
      },
      assertCurrent: () => {
        if (!current) {
          throw new Error("native backup authority lost");
        }
      },
    });
    expect(published).toBe(true);
    expect(result).toMatchObject({ status: "failed", activePackageRoot: null });
    await expectVersion(packageRoot, "1.0.0");
    await expectVersion(
      path.join(transaction.backupRoot, path.relative(native.liveProjectRoot, packageRoot)),
      "1.0.0",
    );
    expect(await transaction.rollback(() => {})).toMatchObject({
      exitCode: 0,
      activePackageRoot: packageRoot,
    });
    await expectVersion(packageRoot, "1.0.0");
  },
);
