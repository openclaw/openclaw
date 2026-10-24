import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { installBunCliLauncher, parseBunCliLauncher } from "../../scripts/lib/bun-cli-launcher.mjs";
import { withTestDir } from "../test-helpers/temp-dir.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import {
  finalizeNativePackageStage,
  prepareNativePackageStage,
} from "./update-native-package-stage.js";

const runFile = promisify(execFile);
async function output(command: string, args: string[] = []) {
  return (await runFile(command, args, { timeout: 5000 })).stdout.trim();
}
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const writeLauncher = (file: string, source: string) => fs.writeFile(file, source, { mode: 0o755 });
async function prepareStage(installTarget: ResolvedGlobalInstallTarget, globalBinDir: string) {
  const stage = await prepareNativePackageStage({
    installTarget,
    globalBinDir,
    packageName: "openclaw",
    installSpec: "openclaw@2.0.0",
    env: {},
  });
  assert.ok(stage, "missing native stage");
  return stage;
}

async function writeStoredRuntime(packageRoot: string, store: string, generation: string) {
  const payload = join(store, generation, "node_modules", "aged-runtime");
  const modules = join(packageRoot, "node_modules");
  await fs.mkdir(payload, { recursive: true });
  await fs.mkdir(modules, { recursive: true });
  await fs.writeFile(join(payload, "index.cjs"), `module.exports = ${JSON.stringify(generation)};`);
  await fs.rm(join(modules, "aged-runtime"), { force: true });
  await fs.symlink(relative(modules, payload), join(modules, "aged-runtime"));
  await writeLauncher(
    join(packageRoot, "openclaw.mjs"),
    '#!/usr/bin/env node\nimport value from "./node_modules/aged-runtime/index.cjs";\nconsole.log(value);\n',
  );
}

describe.skipIf(process.platform === "win32")("native package stage", () => {
  it.each(["bun", "bun-launcher", "pnpm10", "pnpm11", "pnpm12"] as const)(
    "preserves the live %s project and executes its relocated candidate launcher",
    async (layout) =>
      withTestDir({ prefix: "native-package-stage-" }, async (base) => {
        const grouped = layout === "pnpm11" || layout === "pnpm12";
        const manager = layout.startsWith("bun") ? "bun" : "pnpm";
        const project = join(
          base,
          layout === "bun-launcher" ? "Bun ' install" : "",
          "install/global",
        );
        const globalRoot = join(
          project,
          grouped ? "v11" : layout === "pnpm10" ? "5/node_modules" : "node_modules",
        );
        const packageRoot = join(globalRoot, grouped ? "group/node_modules" : "", "openclaw");
        const liveBinDir = join(base, "bin");
        const binTarget = layout === "pnpm12" ? join(base, "physical", "bin") : liveBinDir;
        const external = join(base, "shared-store");
        await fs.mkdir(packageRoot, { recursive: true });
        await fs.mkdir(binTarget, { recursive: true });
        if (layout === "pnpm12") {
          await fs.symlink(binTarget, liveBinDir);
        }
        await fs.mkdir(external);
        await fs.writeFile(join(external, "dependency"), "shared dependency");
        const virtualStoreDir = join(project, layout === "pnpm10" ? "5/.pnpm" : "store");
        if (layout === "pnpm10") {
          const externalStore = join(external, "pnpm-store");
          await fs.mkdir(externalStore);
          await fs.symlink(externalStore, virtualStoreDir);
        }
        await writeJson(join(project, "package.json"), {
          dependencies: { sibling: "file:../sibling" },
        });
        await writeStoredRuntime(packageRoot, virtualStoreDir, "old");
        await fs.symlink(packageRoot, join(project, "owned-package"));
        await fs.symlink(relative(project, external), join(project, "shared-package"));
        if (grouped) {
          await fs.symlink(dirname(dirname(packageRoot)), join(globalRoot, "active-hash"));
        }
        const modulesManifest = join(packageRoot, ".modules.yaml");
        await writeJson(modulesManifest, { virtualStoreDir, storeDir: external });
        const stage = await prepareStage(
          { manager, command: manager, globalRoot, packageRoot },
          liveBinDir,
        );
        const liveEntry = join(packageRoot, "openclaw.mjs");
        const liveOutput = () => output(process.execPath, [liveEntry]);
        const expectModules = async (file: string, store = virtualStoreDir) =>
          expect(await readJson(file)).toEqual({ virtualStoreDir: store, storeDir: external });
        let candidateRoot = join(stage.projectRoot, relative(project, packageRoot));
        if (layout === "pnpm12") {
          const newGroupRoot = join(stage.globalRoot, "new-group", "node_modules", "openclaw");
          await fs.cp(candidateRoot, newGroupRoot, { recursive: true, verbatimSymlinks: true });
          candidateRoot = newGroupRoot;
          await fs.unlink(join(stage.projectRoot, "owned-package"));
          await fs.symlink(candidateRoot, join(stage.projectRoot, "owned-package"));
        }
        const liveCandidateRoot = join(project, relative(stage.projectRoot, candidateRoot));
        const candidateEntry = join(candidateRoot, "openclaw.mjs");
        const candidateStore = join(stage.projectRoot, relative(project, virtualStoreDir));
        expect((await fs.lstat(candidateStore)).isSymbolicLink()).toBe(false);
        expect(await fs.realpath(candidateStore)).toBe(candidateStore);
        expect(await output(process.execPath, [candidateEntry])).toBe("old");
        // An aged pnpm install prunes the old payload before installing its replacement.
        await fs.rm(join(candidateStore, "old"), { recursive: true });
        expect(await liveOutput()).toBe("old");
        if (layout === "pnpm10") {
          expect((await fs.lstat(virtualStoreDir)).isSymbolicLink()).toBe(true);
          expect(await fs.realpath(virtualStoreDir)).toBe(join(external, "pnpm-store"));
        }
        expect(await fs.realpath(join(stage.projectRoot, "owned-package"))).toBe(candidateRoot);
        expect(await fs.realpath(join(stage.projectRoot, "shared-package"))).toBe(external);
        expect(resolve(stage.projectRoot, "../sibling")).toBe(resolve(project, "../sibling"));
        await expectModules(join(candidateRoot, ".modules.yaml"), candidateStore);
        await writeStoredRuntime(candidateRoot, candidateStore, "candidate");
        const internalLauncher = join(candidateRoot, "node_modules", ".bin", "probe");
        if (layout === "pnpm12") {
          await fs.mkdir(dirname(internalLauncher), { recursive: true });
          await writeLauncher(
            internalLauncher,
            `#!/bin/sh\nbasedir_abs=$(CDPATH= cd -P -- "$(dirname "$0")" && pwd -P)\nexec node "$basedir_abs/${relative(dirname(internalLauncher), candidateEntry)}" "$@"\n`,
          );
          await expect(fs.access(liveCandidateRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const externalEntry = join(external, "entry.mjs");
        await fs.writeFile(externalEntry, 'console.log("external");\n');
        const externalLauncher = join(stage.binDir, "shared");
        await writeLauncher(
          externalLauncher,
          `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${relative(stage.binDir, externalEntry)}" "$@"\n`,
        );
        expect(await output(externalLauncher)).toBe("external");
        const launcher = join(stage.binDir, "openclaw");
        if (layout.startsWith("bun")) {
          await fs.symlink(relative(stage.binDir, candidateEntry), launcher);
          if (layout === "bun-launcher") {
            installBunCliLauncher({
              packageRoot: candidateRoot,
              bunPath: process.execPath,
              binDir: stage.binDir,
            });
          }
        } else {
          const target = relative(stage.binDir, candidateEntry);
          const basedir = layout === "pnpm12" ? "basedir_abs" : "basedir";
          const convertedBranch =
            layout === "pnpm12"
              ? `basedir_win="$basedir_abs"\nif [ "$1" = win ]; then\n  exec node "$basedir_win/${target}" "$@"\nfi\n`
              : "";
          await writeLauncher(
            launcher,
            `#!/bin/sh\n${basedir}=$(CDPATH= cd -P -- "$(dirname "$0")" && pwd -P)\n${convertedBranch}if [ -x "$${basedir}/node" ]; then\n  exec "$${basedir}/node" "$${basedir}/${target}" "$@"\nelse\n  exec node "$${basedir}/${target}" "$@"\nfi\n# cmd-shim-target=${candidateEntry}\n`,
          );
          const node = process.execPath.replaceAll("'", "'\\''");
          await writeLauncher(
            join(liveBinDir, "node"),
            `#!/bin/sh\nprintf 'bin-runtime\\n'\nexec '${node}' "$@"\n`,
          );
        }
        expect(await output(launcher)).toBe("candidate");
        await finalizeNativePackageStage(stage, "openclaw");
        if (layout === "bun-launcher") {
          expect(parseBunCliLauncher(await fs.readFile(launcher, "utf8"))).toEqual({
            bunPath: process.execPath,
            entryPath: liveEntry,
          });
        }
        expect(await liveOutput()).toBe("old");
        await expectModules(modulesManifest);
        await fs.rename(project, `${project}.previous`);
        await fs.rename(stage.projectRoot, project);
        await fs.cp(launcher, join(liveBinDir, "openclaw"), { verbatimSymlinks: true });
        await fs.copyFile(externalLauncher, join(liveBinDir, "shared"));
        await fs.rm(stage.binDir, { recursive: true });
        expect(await output(join(liveBinDir, "openclaw"))).toBe(
          layout.startsWith("bun") ? "candidate" : "bin-runtime\ncandidate",
        );
        if (layout === "pnpm12") {
          expect(await output(join(liveBinDir, "openclaw"), ["win"])).toBe("candidate");
          expect(
            await output(join(liveCandidateRoot, relative(candidateRoot, internalLauncher))),
          ).toBe("candidate");
        }
        expect(await output(join(liveBinDir, "shared"))).toBe("external");
        expect(await fs.realpath(join(project, "owned-package"))).toBe(liveCandidateRoot);
        expect(await fs.readFile(join(project, "shared-package", "dependency"), "utf8")).toBe(
          "shared dependency",
        );
        await expectModules(modulesManifest);
      }),
  );

  it("rejects a concurrent native owner mutation before finalizing the candidate", async () => {
    await withTestDir({ prefix: "native-package-stage-race-" }, async (base) => {
      const project = join(base, "install", "global");
      const globalRoot = join(project, "node_modules");
      const packageRoot = join(globalRoot, "openclaw");
      await fs.mkdir(packageRoot, { recursive: true });
      const manifest = join(project, "package.json");
      await fs.writeFile(manifest, '{"dependencies":{"openclaw":"1.0.0"}}');
      const stage = await prepareStage(
        { manager: "bun", command: "bun", globalRoot, packageRoot },
        join(base, "bin"),
      );
      const concurrentManifest = '{"dependencies":{"openclaw":"1.0.0","sibling":"2.0.0"}}';
      await fs.writeFile(manifest, concurrentManifest);
      await expect(finalizeNativePackageStage(stage, "openclaw")).rejects.toThrow(
        "changed before activation",
      );
      expect(await fs.readFile(manifest, "utf8")).toBe(concurrentManifest);
      expect(await fs.readdir(stage.binDir)).toEqual([]);
    });
  });
});
