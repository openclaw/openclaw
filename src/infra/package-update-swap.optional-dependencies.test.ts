import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createPnpmTarget, writePackageRoot } from "./package-update-steps.test-support.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { prepareNativePackageStage } from "./update-native-package-stage.js";

const runFile = promisify(execFile);

it.each(["absent", "optional-link", "required-link"] as const)(
  "swaps a Windows pnpm tree with host-only native packages (%s)",
  async (missing) => {
    await withTestDir({ prefix: "native-optional-swap-" }, async (base) => {
      const project = path.join(base, "global");
      const globalRoot = path.join(project, "5", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
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
      assert.ok(native, "missing native stage");
      const candidate = path.join(native.projectRoot, "5", "node_modules", "openclaw");
      await writePackageRoot(candidate, "2.0.0");
      const store = path.join(native.projectRoot, "5", ".pnpm");
      const modules = path.join(store, "@lydell+node-pty@1.2.0-beta.15", "node_modules");
      const owner = path.join(modules, "@lydell", "node-pty");
      const host = path.join(
        store,
        "@lydell+node-pty-win32-x64@1.2.0-beta.15",
        "node_modules",
        "@lydell",
        "node-pty-win32-x64",
      );
      await fs.mkdir(owner, { recursive: true });
      await fs.mkdir(host, { recursive: true });
      const variants = [
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-x64",
        "win32-arm64",
        "win32-x64",
      ];
      await fs.writeFile(
        path.join(owner, "package.json"),
        JSON.stringify({
          name: "@lydell/node-pty",
          optionalDependencies: Object.fromEntries(
            variants.map((variant) => [`@lydell/node-pty-${variant}`, "1.2.0-beta.15"]),
          ),
          dependencies: missing === "required-link" ? { "required-runtime": "1.0.0" } : {},
        }),
      );
      await fs.writeFile(path.join(host, "index.mjs"), 'export default "win32-x64";');
      await fs.symlink(host, path.join(modules, "@lydell", "node-pty-win32-x64"));
      await fs.writeFile(
        path.join(owner, "index.mjs"),
        'export { default } from "../node-pty-win32-x64/index.mjs";',
      );
      const imports = path.join(candidate, "node_modules", "@lydell");
      await fs.mkdir(imports, { recursive: true });
      await fs.symlink(owner, path.join(imports, "node-pty"));
      await fs.writeFile(
        path.join(candidate, "openclaw.mjs"),
        'import native from "./node_modules/@lydell/node-pty/index.mjs"; console.log(native);',
      );
      if (missing !== "absent") {
        const name =
          missing === "optional-link" ? "@lydell/node-pty-darwin-arm64" : "required-runtime";
        const link = path.join(modules, name);
        await fs.symlink(path.join(store, "not-installed", name), link);
      }
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const arch = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
      let result;
      try {
        result = await swapStagedPackageInstall({
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
        });
      } finally {
        platform.mockRestore();
        arch.mockRestore();
      }
      if (missing === "required-link") {
        expect(result).toMatchObject({ status: "failed", step: { exitCode: 1 } });
        expect(result.step.stderrTail).toContain("required-runtime");
        expect(
          JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).version,
        ).toBe("1.0.0");
      } else {
        expect(result).toMatchObject({ status: "committed", step: { exitCode: 0 } });
        expect(
          (await runFile(process.execPath, [path.join(packageRoot, "openclaw.mjs")])).stdout.trim(),
        ).toBe("win32-x64");
        if (missing === "optional-link") {
          await expect(
            fs.lstat(
              path.join(
                project,
                path.relative(native.projectRoot, modules),
                "@lydell",
                "node-pty-darwin-arm64",
              ),
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    });
  },
);
