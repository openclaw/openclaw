import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeInstalledRuntime,
  verifyInstalledRuntimeComposition,
  resolveInstalledRuntimeImageRecipe,
} from "../../scripts/compose-installed-runtime.mts";
import { verifyInstalledRuntimeImageInputs } from "../../scripts/lib/installed-runtime-image-inputs.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const runtimeCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const runtimeLock = readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8");
const owned: string[] = [];
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
async function write(root: string, relative: string, contents: string) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}
function compositionCli(options: Record<string, string>) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/compose-installed-runtime.mts",
        ...Object.entries(options).flatMap(([name, value]) => [
          "--" + name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()),
          value,
        ]),
      ],
      { cwd: repo, encoding: "utf8" },
    ),
  );
}

async function fixture(
  rootImports?: "present" | "missing",
  promotion?: "present" | "bundled" | "version" | "undeclared" | "transitive-missing",
  foreignLinkMode = false,
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "installed-composition-")),
  );
  owned.push(root);
  const source = path.join(root, "source");
  const deps = path.join(root, "deps");
  const pack = path.join(root, "package");
  const manifest = {
    name: "openclaw",
    version: "1.0.0",
    type: "module",
    files: [],
    devDependencies: { private: "9.0.0" },
    dependencies: { bundled: "1.0.0", external: "1.0.0", fs: "1.0.0" },
  };
  const build = { version: "1.0.0", commit: runtimeCommit, buildId: "fixture-a" };
  for (const dir of [source, deps, pack]) {
    await write(dir, "package.json", JSON.stringify(manifest));
  }
  for (const dir of [source, deps]) {
    await write(dir, "pnpm-lock.yaml", runtimeLock);
  }
  await write(source, "dist/build-info.json", JSON.stringify(build));
  await write(source, "Dockerfile", "FROM qualified-fixture\n");
  await write(source, "docker-entrypoint.mjs", 'import "./cli-root-options.mjs";\n');
  // Portable packages omit Docker's lock/entrypoint, but include these public runtime files.
  for (const name of [
    "pnpm-workspace.yaml",
    "node-version.mjs",
    "node-sqlite.mjs",
    "node-sqlite-capabilities.mjs",
    "runtime-process-bootstrap.generated.mjs",
    "runtime-process-scripts.generated.mjs",
    "node-runtime-update.mjs",
    "node-runtime-recovery.mjs",
    "cli-parent-lifetime.mjs",
    "node-runtime-env.mjs",
    "cli-invocation.mjs",
    "cli-root-options.mjs",
    "gateway-run-argv.mjs",
    "gateway-shutdown-budget.mjs",
    "node-host-launcher.mjs",
    "node-compile-cache.mjs",
    "openclaw.mjs",
  ]) {
    await write(pack, name, "// portable fixture\n");
  }
  for (const name of ["docs", "skills", "patches"]) {
    await fs.mkdir(path.join(pack, name), { recursive: true });
  }
  await fs.symlink(path.join(repo, "scripts"), path.join(source, "scripts"));
  await fs.symlink(path.join(repo, "src"), path.join(source, "src"));
  await write(
    deps,
    "runtime-input.json",
    JSON.stringify({
      platform: "linux",
      arch: "x64",
      packageJsonSha256: digest(JSON.stringify(manifest)),
      lockfileSha256: digest(runtimeLock),
    }),
  );
  const addPackage = async (
    where: string,
    name: string,
    version: string,
    dependencies = {},
    optionalDependencies = {},
    packageExports: string | Record<string, string> = "./index.js",
  ) => {
    await write(
      where,
      "package.json",
      JSON.stringify({
        name,
        version,
        type: "module",
        exports: packageExports,
        dependencies,
        optionalDependencies,
      }),
    );
    await write(where, "index.js", `export default ${JSON.stringify(version)};\n`);
  };
  await addPackage(
    path.join(pack, "node_modules/bundled"),
    "bundled",
    "1.0.0",
    { "bundled-transitive": "1.0.0" },
    { "bundled-native": "1.0.0" },
  );
  await write(pack, "node_modules/bundled/preserved.txt", "portable owns this\n");
  await addPackage(
    path.join(deps, "node_modules/bundled"),
    "bundled",
    "1.0.0",
    { "bundled-transitive": "1.0.0" },
    { "bundled-native": "1.0.0" },
  );
  for (const name of ["bundled-transitive", "bundled-native"]) {
    await addPackage(path.join(deps, "node_modules/bundled/node_modules", name), name, "1.0.0");
  }
  await addPackage(path.join(deps, "node_modules/hoisted-only"), "hoisted-only", "1.0.0");
  await addPackage(path.join(deps, "node_modules/private"), "private", "9.0.0");
  await addPackage(path.join(deps, "extensions/demo/node_modules/external"), "external", "5.0.0");
  await write(deps, "node_modules/bundled/preserved.txt", "WRONG source workspace\n");
  await addPackage(
    path.join(deps, "node_modules/external"),
    "external",
    "1.0.0",
    { nested: "2.0.0" },
    {},
    { ".": "./index.js", "./implementation": "./src/entry.js" },
  );
  await write(
    deps,
    "node_modules/external/src/entry.js",
    'export { default } from "implementation-helper";\n',
  );
  await addPackage(
    path.join(deps, "node_modules/external/src/node_modules/implementation-helper"),
    "implementation-helper",
    "4.0.0",
  );
  await addPackage(path.join(deps, "node_modules/external/node_modules/nested"), "nested", "2.0.0");
  if (foreignLinkMode) {
    await fs.mkdir(path.join(deps, ".store/node_modules"), { recursive: true });
    await fs.rename(
      path.join(deps, "node_modules/external"),
      path.join(deps, ".store/node_modules/external"),
    );
    await fs.symlink("../.store/node_modules/external", path.join(deps, "node_modules/external"));
    await write(deps, "._authored", "authored input, not generated transport metadata\n");
  }
  await addPackage(path.join(deps, "node_modules/fs"), "fs", "1.0.0", { nested: "1.0.0" });
  await addPackage(path.join(deps, "node_modules/fs/node_modules/nested"), "nested", "1.0.0");
  await addPackage(
    path.join(deps, "extensions/demo/node_modules/private"),
    "private",
    promotion === "version" ? "4.0.0" : "3.0.0",
    promotion ? { nested: "3.0.0" } : {},
  );
  if (promotion === "bundled") {
    await addPackage(path.join(pack, "node_modules/private"), "private", "3.0.0", {
      nested: "3.0.0",
    });
    await write(pack, "node_modules/private/preserved.txt", "portable promoted bundle\n");
  }
  if (promotion) {
    const name = promotion === "undeclared" ? "undeclared" : "private";
    await write(
      pack,
      "package.json",
      JSON.stringify({
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          [name]: promotion === "undeclared" ? "1.0.0" : "3.0.0",
        },
      }),
    );
    if (promotion !== "transitive-missing") {
      await addPackage(
        path.join(deps, "extensions/demo/node_modules/private/node_modules/nested"),
        "nested",
        "3.0.0",
      );
    }
    await addPackage(
      path.join(deps, "extensions/demo/node_modules/undeclared"),
      "undeclared",
      "1.0.0",
    );
  }
  await write(
    pack,
    "dist/extensions/demo/package.json",
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: {
        private: "3.0.0",
        "plugin-bundled": "1.0.0",
        "hoisted-only": "1.0.0",
        external: "5.0.0",
      },
      peerDependencies: { openclaw: "*" },
    }),
  );
  await addPackage(
    path.join(pack, "dist/extensions/demo/node_modules/plugin-bundled"),
    "plugin-bundled",
    "1.0.0",
  );
  await write(
    pack,
    "dist/extensions/demo/node_modules/plugin-bundled/preserved.txt",
    "portable plugin owns this\n",
  );
  await addPackage(
    path.join(deps, "extensions/demo/node_modules/plugin-bundled"),
    "plugin-bundled",
    "1.0.0",
  );
  await write(
    deps,
    "extensions/demo/node_modules/plugin-bundled/preserved.txt",
    "WRONG dependency source\n",
  );
  await write(pack, "dist/build-info.json", JSON.stringify(build));
  await write(pack, "dist/entry.js", "export const fromPortable = true;\n");
  if (rootImports) {
    await write(pack, "gateway-prewarm.mjs", 'import "./dist/gateway-prewarm.js";\n');
    await write(pack, "node-runtime-update.mjs", 'import "./scripts/windows-cmd-helpers.mjs";\n');
    await write(
      pack,
      "openclaw.mjs",
      'import "./dist/extensions/browser/native-host-entry.js"; import "./dist/infra/package-lifecycle.js";\n',
    );
    for (const target of [
      "dist/gateway-prewarm.js",
      "dist/extensions/browser/native-host-entry.js",
      "dist/infra/package-lifecycle.js",
    ]) {
      await write(pack, target, "export {};\n");
    }
    if (rootImports === "present") {
      await write(pack, "scripts/windows-cmd-helpers.mjs", "export {};\n");
    }
  }
  await tar.create({ cwd: root, file: path.join(root, "portable.tgz"), gzip: true }, ["package"]);
  const archive = await fs.readFile(path.join(root, "portable.tgz"));
  await write(
    root,
    "package-receipt.json",
    JSON.stringify({ sha256: digest(archive), bytes: archive.length, buildInfo: build }),
  );
  // Independent fixed filesystem inventory supplied by the input owner, not the subject.
  const rows: Record<string, unknown>[] = [];
  async function visit(relative = "") {
    const file = path.join(deps, relative);
    const stat = await fs.lstat(file);
    const row: Record<string, unknown> = {
      path: `node-runtime-dependencies/linux-x64${relative ? `/${relative}` : ""}`,
      mode: `0o${(stat.mode & 0o777).toString(8)}`,
      kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file",
    };
    if (stat.isSymbolicLink()) {
      row.target = await fs.readlink(file);
      // Declare the other physical representation, as a cross-OS input producer would.
      row.mode = (stat.mode & 0o777) === 0o755 ? "0o777" : "0o755";
    }
    if (stat.isFile()) {
      const bytes = await fs.readFile(file);
      row.size = bytes.length;
      row.sha256 = digest(bytes);
    }
    rows.push(row);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).toSorted()) {
        await visit([relative, name].filter(Boolean).join("/"));
      }
    }
  }
  await visit();
  const inventory = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await write(root, "linux.jsonl", inventory);
  return {
    root,
    deps,
    options: {
      package: path.join(root, "portable.tgz"),
      packageReceipt: path.join(root, "package-receipt.json"),
      dependencyRoot: deps,
      dependencyManifest: path.join(root, "linux.jsonl"),
      dependencyManifestSha256: digest(inventory),
      sourceRoot: source,
      platform: "linux",
      arch: "x64",
      outputDir: path.join(root, "composed"),
    },
  };
}

afterEach(async () => {
  for (const root of owned.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
describe("offline installed runtime composition", () => {
  it("accepts transported symlink permission representation without changing source facts", async () => {
    const { deps, options } = await fixture(undefined, undefined, true);
    const original = await fs.readFile(options.dependencyManifest, "utf8");
    const result = await composeInstalledRuntime(options);
    expect(result.inputs.dependencyManifest.physicalSymlinkModeDifferences).toBe(1);
    expect(await fs.readFile(options.dependencyManifest, "utf8")).toBe(original);
    expect(await fs.readlink(path.join(deps, "node_modules/external"))).toBe(
      "../.store/node_modules/external",
    );
    expect(await fs.readFile(path.join(deps, "._authored"), "utf8")).toBe(
      "authored input, not generated transport metadata\n",
    );
    const installed = path.join(options.outputDir, "app/node_modules/external");
    expect((await fs.lstat(installed)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(installed, "index.js"), "utf8")).toBe(
      'export default "1.0.0";\n',
    );
  });
  it.each(["target", "file-mode", "directory-mode", "extra-entry"] as const)(
    "retains strict dependency %s checks with transported symlink metadata",
    async (failure) => {
      const { deps, options } = await fixture(undefined, undefined, true);
      let expected = "Dependency inventory mismatch: node-runtime-dependencies/linux-x64/";
      if (failure === "target") {
        await fs.unlink(path.join(deps, "node_modules/external"));
        await fs.symlink("fs", path.join(deps, "node_modules/external"));
        expected += "node_modules/external";
      } else if (failure === "extra-entry") {
        await write(deps, "._transport-extra", "unexpected\n");
        expected = "Dependency inventory entry count mismatch";
      } else {
        const relative =
          ".store/node_modules/external" + (failure === "file-mode" ? "/index.js" : "");
        const file = path.join(deps, relative);
        await fs.chmod(file, (await fs.stat(file)).mode ^ 0o020);
        expected += relative;
      }
      await expect(composeInstalledRuntime(options)).rejects.toThrow(expected);
      await expect(fs.access(path.join(options.outputDir, "receipt.json"))).rejects.toThrow();
    },
  );
  it("reuses a strict qualification after relocation, checking graph and selected bytes", async () => {
    const { root, deps, options } = await fixture(undefined, undefined, true);
    await composeInstalledRuntime(options);
    const receipt = path.join(options.outputDir, "receipt.json");
    const qualifiedDependencyInput = {
      receipt: { path: receipt, sha256: digest(await fs.readFile(receipt)) },
    };
    const relocated = path.join(root, "relocated");
    await fs.cp(deps, relocated, { recursive: true, verbatimSymlinks: true });
    // Unselected payloads are not admitted by reuse. Their graph metadata still is.
    await write(relocated, "node_modules/private/index.js", 'export default "8.0.0";\n');
    const reuse = {
      ...options,
      dependencyRoot: relocated,
      qualifiedDependencyInput,
      outputDir: path.join(root, "reuse"),
    };
    await expect(
      composeInstalledRuntime({ ...reuse, qualifiedDependencyInput: undefined }),
    ).rejects.toThrow(/Dependency inventory mismatch/);
    const result = compositionCli({
      ...options,
      dependencyRoot: relocated,
      outputDir: reuse.outputDir,
      qualifiedDependencyReceipt: receipt,
      qualifiedDependencyReceiptSha256: qualifiedDependencyInput.receipt.sha256,
    });
    expect(result.inputs.dependencyManifest.inputVerification.mode).toBe("qualified-reuse");
    expect(result.checks.inputInventory).toBe(false);
    expect(
      await fs.readFile(path.join(reuse.outputDir, "app/node_modules/external/index.js"), "utf8"),
    ).toBe('export default "1.0.0";\n');
    const selected = ".store/node_modules/external/src/node_modules/implementation-helper/index.js";
    for (const failure of ["content", "mode", "missing", "manifest", "link", "escape"] as const) {
      const donor = path.join(root, failure);
      await fs.cp(relocated, donor, { recursive: true, verbatimSymlinks: true });
      if (failure === "content") {
        await write(donor, selected, 'export default "8.0.0";\n');
      }
      if (failure === "mode") {
        await fs.chmod(path.join(donor, selected), 0o700);
      }
      if (failure === "missing") {
        await fs.rm(path.join(donor, selected));
      }
      if (failure === "manifest") {
        const file = path.join(donor, ".store/node_modules/external/package.json");
        const manifest = JSON.parse(await fs.readFile(file, "utf8"));
        manifest.dependencies.nested = "9.0.0";
        await fs.writeFile(file, JSON.stringify(manifest));
      }
      if (failure === "link" || failure === "escape") {
        await fs.unlink(path.join(donor, "node_modules/external"));
        await fs.symlink(
          failure === "link" ? "fs" : path.join(relocated, ".store/node_modules/external"),
          path.join(donor, "node_modules/external"),
        );
      }
      const outputDir = path.join(root, "rejected-" + failure);
      await expect(
        composeInstalledRuntime({ ...reuse, dependencyRoot: donor, outputDir }),
      ).rejects.toThrow(/Dependency inventory|Unsafe dependency link/);
      await expect(fs.access(path.join(outputDir, "receipt.json"))).rejects.toThrow();
    }
    // A partial composition must never become a full qualification for another reuse.
    const partial = path.join(reuse.outputDir, "receipt.json");
    await expect(
      composeInstalledRuntime({
        ...reuse,
        outputDir: path.join(root, "recursive"),
        qualifiedDependencyInput: {
          receipt: { path: partial, sha256: digest(await fs.readFile(partial)) },
        },
      }),
    ).rejects.toThrow(/qualification/);
  });
  it("binds archive recipes to consumed bytes, not the mutable app directory", async () => {
    const { root, options } = await fixture();
    const result = await composeInstalledRuntime(options);
    const verification = {
      compositionRoot: options.outputDir,
      receiptSha256: digest(await fs.readFile(path.join(options.outputDir, "receipt.json"))),
      portablePackageSha256: digest(await fs.readFile(options.package)),
      expectedRuntime: result.runtime,
    };
    await write(path.join(options.outputDir, "app"), "dist/entry.js", "tampered app\n");
    await expect(resolveInstalledRuntimeImageRecipe(verification)).rejects.toThrow(
      /inventory mismatch/,
    );
    const recipe = compositionCli({
      operation: "image-recipe",
      imageInput: "archive",
      compositionRoot: verification.compositionRoot,
      receiptSha256: verification.receiptSha256,
      portablePackageSha256: verification.portablePackageSha256,
      runtimeVersion: result.runtime.version,
      runtimeCommit: result.runtime.commit,
      runtimeBuildId: result.runtime.buildId,
    });
    expect(recipe.composition.verification.mode).toBe("archive-bound");
    expect(recipe.buildArgs).toMatchObject({
      OPENCLAW_INSTALLED_RUNTIME_INPUT: "installed-runtime-archive-input",
      OPENCLAW_INSTALLED_RUNTIME_SHA256: result.archive.sha256,
    });
    const unpacked = path.join(root, "archive-consumer");
    await fs.mkdir(unpacked);
    await tar.extract({ file: result.archive.path, cwd: unpacked });
    expect(await fs.readFile(path.join(unpacked, "app/dist/entry.js"), "utf8")).toBe(
      "export const fromPortable = true;\n",
    );
    const rootModule = path.join(options.outputDir, "app/node-runtime-update.mjs");
    const original = await fs.readFile(rootModule);
    await fs.writeFile(rootModule, "// replaced root module\n");
    await expect(
      resolveInstalledRuntimeImageRecipe({ ...verification, imageInput: "archive" }),
    ).rejects.toThrow(/recipe input mismatch/);
    await fs.writeFile(rootModule, original);
    await fs.appendFile(result.archive.path, "tamper");
    await expect(
      resolveInstalledRuntimeImageRecipe({ ...verification, imageInput: "archive" }),
    ).rejects.toThrow(/archive\/manifest identity/);
  });
  it("preserves portable bundled content and importer-relative versions without source links", async () => {
    const { root, options } = await fixture();
    const result = await composeInstalledRuntime(options);
    const installed = path.join(root, "consumer");
    await fs.mkdir(installed);
    await tar.extract({ file: result.archive.path, cwd: installed });
    const app = path.join(installed, "app");
    expect(await fs.readFile(path.join(app, "node_modules/bundled/preserved.txt"), "utf8")).toBe(
      "portable owns this\n",
    );
    const answer = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {createRequire} from 'node:module'; const r=createRequire(${JSON.stringify(path.join(app, "package.json"))}); const e=r.resolve('external'); console.log(r(r.resolve('nested',{paths:[e]})).default); const b=r.resolve('bundled'); for (const name of ['bundled-transitive','bundled-native']) console.log(r(r.resolve(name,{paths:[b]})).default); const p=createRequire(${JSON.stringify(path.join(app, "extensions/demo/package.json"))}); console.log(p('hoisted-only').default); console.log(r('external/implementation').default)`,
      ],
      { encoding: "utf8" },
    );
    expect(answer.trim().split("\n")).toEqual(["2.0.0", "1.0.0", "1.0.0", "1.0.0", "4.0.0"]);
    const moduleVersion = async (file: string) =>
      JSON.parse(await fs.readFile(file, "utf8")).version;
    expect(
      await moduleVersion(path.join(app, "node_modules/fs/node_modules/nested/package.json")),
    ).toBe("1.0.0");
    expect(
      await moduleVersion(path.join(app, "extensions/demo/node_modules/private/package.json")),
    ).toBe("3.0.0");
    expect(await fs.readFile(path.join(app, "dist/entry.js"), "utf8")).toBe(
      "export const fromPortable = true;\n",
    );
    expect(
      await fs.readFile(
        path.join(app, "extensions/demo/node_modules/plugin-bundled/preserved.txt"),
        "utf8",
      ),
    ).toBe("portable plugin owns this\n");
    expect(result.runtime.commit).toBe(runtimeCommit);
    expect(result.lifecycle).toMatchObject({ status: "target-required", completed: false });
    await expect(fs.access(path.join(app, ".openclaw-lifecycle-pending"))).resolves.toBeUndefined();
    expect(result.archive.sha256).toBe(digest(await fs.readFile(result.archive.path)));
    const verification = {
      compositionRoot: options.outputDir,
      receiptSha256: digest(await fs.readFile(path.join(options.outputDir, "receipt.json"))),
      portablePackageSha256: digest(await fs.readFile(options.package)),
      expectedRuntime: { version: "1.0.0", commit: runtimeCommit, buildId: "fixture-a" },
    };
    const recipe = await resolveInstalledRuntimeImageRecipe(verification);
    expect(recipe).toMatchObject({
      schema: "openclaw.installed-runtime.image-recipe.v1",
      target: "openclaw-runtime",
      buildArgs: { OPENCLAW_RUNTIME_ASSETS: "installed-runtime-assets" },
      namedContexts: { openclaw_installed_runtime: options.outputDir },
      composition: {
        compositionOnly: true,
        appRoot: path.join(options.outputDir, "app"),
        lifecycle: { completed: false, status: "target-required" },
      },
    });
    expect(recipe.dockerfile.path).toBe(path.join(repo, "Dockerfile"));
    expect(recipe.dockerfile.sha256).toBe(digest(await fs.readFile(path.join(repo, "Dockerfile"))));
    const missingIdentity = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/compose-installed-runtime.mts",
        "--operation",
        "verify",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(missingIdentity.status).toBe(1);
    expect(missingIdentity.stdout).toBe("");
    expect(missingIdentity.stderr).toContain("Missing --composition-root");
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          "scripts/compose-installed-runtime.mts",
          "--operation",
          "verify",
          "--composition-root",
          verification.compositionRoot,
          "--receipt-sha256",
          verification.receiptSha256,
          "--portable-package-sha256",
          verification.portablePackageSha256,
          "--runtime-version",
          "1.0.0",
          "--runtime-commit",
          runtimeCommit,
          "--runtime-build-id",
          "fixture-a",
        ],
        { cwd: repo, encoding: "utf8" },
      ),
    );
    expect(cli).toMatchObject({
      schema: "openclaw.installed-runtime.verification.v1",
      compositionOnly: true,
      runtime: verification.expectedRuntime,
    });
  });
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    "finalizes only after a real native probe, using the staged helper closure",
    async () => {
      const { options } = await fixture();
      await composeInstalledRuntime(options);
      const app = path.join(options.outputDir, "app");
      await fs.cp(path.join(app, ".runtime-bootstrap/scripts"), path.join(app, "scripts"), {
        recursive: true,
      });
      await fs.copyFile(
        path.join(repo, "runtime-process-bootstrap.generated.mjs"),
        path.join(app, "runtime-process-bootstrap.generated.mjs"),
      );
      await write(
        app,
        "dist/postinstall-inventory.json",
        JSON.stringify([
          "dist/build-info.json",
          "dist/entry.js",
          "dist/extensions/demo/package.json",
        ]),
      );
      await write(app, "dist/stale.js", "obsolete");
      const finalize = () =>
        spawnSync(
          process.execPath,
          [path.join(app, ".runtime-bootstrap/scripts/finalize-installed-runtime.mjs"), app],
          { cwd: app, encoding: "utf8" },
        );
      const missingNative = finalize();
      expect(missingNative.status).not.toBe(0);
      expect(missingNative.stderr).toContain("no npm repair allowed");
      await expect(
        fs.access(path.join(app, ".openclaw-lifecycle-pending")),
      ).resolves.toBeUndefined();
      expect(await fs.readFile(path.join(app, "dist/stale.js"), "utf8")).toBe("obsolete");
      for (const name of ["@openclaw/fs-safe", "acorn", "semver"]) {
        const destination = path.join(app, "node_modules", name);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.symlink(await fs.realpath(path.join(repo, "node_modules", name)), destination);
      }
      const finalized = finalize();
      expect(finalized.status, finalized.stderr).toBe(0);
      await expect(fs.access(path.join(app, ".openclaw-lifecycle-pending"))).rejects.toThrow();
      await expect(fs.access(path.join(app, "dist/stale.js"))).rejects.toThrow();
      expect(
        await fs.readFile(
          path.join(app, "dist/extensions/demo/node_modules/plugin-bundled/preserved.txt"),
          "utf8",
        ),
      ).toBe("portable plugin owns this\n");
    },
  );
  it.each(["present", "bundled", "version", "undeclared", "transitive-missing"] as const)(
    "resolves promoted root dependency: %s",
    async (mode) => {
      const { root, options } = await fixture(undefined, mode);
      if (mode !== "present" && mode !== "bundled") {
        const error =
          mode === "version"
            ? /dependency identity mismatch: private@3.0.0/
            : mode === "undeclared"
              ? /openclaw requires undeclared/
              : /private requires nested/;
        await expect(composeInstalledRuntime(options)).rejects.toThrow(error);
        await expect(fs.access(path.join(options.outputDir, "receipt.json"))).rejects.toThrow();
        return;
      }
      await composeInstalledRuntime(options);
      const app = path.join(options.outputDir, "app");
      const answer = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {createRequire} from 'node:module'; const r=createRequire(${JSON.stringify(path.join(app, "package.json"))}); const p=r.resolve('private'); console.log(r(r.resolve('nested',{paths:[p]})).default); console.log(r('nested').default);`,
        ],
        { encoding: "utf8" },
      );
      expect(answer.trim().split("\n")).toEqual(["3.0.0", "2.0.0"]);
      expect(
        JSON.parse(await fs.readFile(path.join(app, "node_modules/private/package.json"), "utf8"))
          .version,
      ).toBe("3.0.0");
      expect(
        JSON.parse(await fs.readFile(path.join(app, "node_modules/external/package.json"), "utf8"))
          .version,
      ).toBe("1.0.0");
      if (mode === "bundled") {
        expect(
          await fs.readFile(path.join(app, "node_modules/private/preserved.txt"), "utf8"),
        ).toBe("portable promoted bundle\n");
      }
      await expect(fs.access(path.join(app, "node_modules/undeclared"))).rejects.toThrow();
      const manifest = await fs.readFile(
        path.join(options.outputDir, "installed-runtime.manifest.jsonl"),
        "utf8",
      );
      expect(manifest).not.toContain(root);
    },
  );
  it("qualifies Docker-only inputs without modifying the portable composition", async () => {
    const { root, options } = await fixture();
    const result = await composeInstalledRuntime(options);
    const app = path.join(options.outputDir, "app");
    const verification = {
      compositionRoot: options.outputDir,
      receiptSha256: digest(await fs.readFile(path.join(options.outputDir, "receipt.json"))),
      portablePackageSha256: digest(await fs.readFile(options.package)),
      expectedRuntime: result.runtime,
    };
    const verified = await verifyInstalledRuntimeComposition(verification);
    expect(verified.imageAssets).toEqual([
      { path: "pnpm-lock.yaml", sha256: digest(runtimeLock) },
      {
        path: "docker-entrypoint.mjs",
        sha256: digest(await fs.readFile(path.join(repo, "docker-entrypoint.mjs"))),
      },
    ]);
    await expect(fs.access(path.join(app, "pnpm-lock.yaml"))).rejects.toThrow();
    await expect(fs.access(path.join(app, "docker-entrypoint.mjs"))).rejects.toThrow();
    await fs.rm(path.join(app, "pnpm-workspace.yaml"));
    await expect(verifyInstalledRuntimeComposition(verification)).rejects.toThrow(
      /Installed runtime inventory entry count mismatch/,
    );
    await expect(fs.access(path.join(root, "package", "pnpm-lock.yaml"))).rejects.toThrow();
  });
  it.each(["present", "missing"] as const)(
    "checks %s root-to-dist/scripts targets against the full inventory",
    async (mode) => {
      const { options } = await fixture(mode);
      const result = await composeInstalledRuntime(options);
      const input = {
        compositionRoot: options.outputDir,
        receiptSha256: digest(await fs.readFile(path.join(options.outputDir, "receipt.json"))),
        portablePackageSha256: digest(await fs.readFile(options.package)),
        expectedRuntime: result.runtime,
      };
      if (mode === "present") {
        await expect(verifyInstalledRuntimeComposition(input)).resolves.toMatchObject({
          compositionOnly: true,
        });
      } else {
        await expect(verifyInstalledRuntimeComposition(input)).rejects.toThrow(
          /^node-runtime-update.mjs imports missing scripts\/windows-cmd-helpers.mjs$/,
        );
      }
    },
  );
  it("refuses mismatched or missing native Docker source inputs", async () => {
    const { root, options } = await fixture();
    await composeInstalledRuntime(options);
    const tools = path.join(root, "tools");
    execFileSync("git", ["clone", "--depth=1", "--no-local", "-n", "-q", repo, tools]);
    for (const name of ["Dockerfile", "pnpm-lock.yaml", "docker-entrypoint.mjs"]) {
      await fs.copyFile(path.join(repo, name), path.join(tools, name));
    }
    const input = {
      appRoot: path.join(options.outputDir, "app"),
      nativeToolRoot: tools,
      runtimeCommit,
      sourceLockSha256: digest(runtimeLock),
      availableFiles: [],
    };
    await write(tools, "pnpm-lock.yaml", "wrong lock\n");
    await expect(verifyInstalledRuntimeImageInputs(input)).rejects.toThrow(
      /source lock identity mismatch/,
    );
    await fs.copyFile(path.join(repo, "pnpm-lock.yaml"), path.join(tools, "pnpm-lock.yaml"));
    await fs.appendFile(path.join(tools, "docker-entrypoint.mjs"), "// changed\n");
    await expect(verifyInstalledRuntimeImageInputs(input)).rejects.toThrow(
      /entrypoint differs from original runtime commit/,
    );
    await fs.rm(path.join(tools, "docker-entrypoint.mjs"));
    await expect(verifyInstalledRuntimeImageInputs(input)).rejects.toThrow(/ENOENT/);
  });
  it.each(["receipt", "package", "runtime", "archive", "manifest", "content", "mode", "link"])(
    "refuses changed %s at installed-output consumption",
    async (failure) => {
      const { root, options } = await fixture();
      await composeInstalledRuntime(options);
      const verification = {
        compositionRoot: options.outputDir,
        receiptSha256: digest(await fs.readFile(path.join(options.outputDir, "receipt.json"))),
        portablePackageSha256: digest(await fs.readFile(options.package)),
        expectedRuntime: { version: "1.0.0", commit: runtimeCommit, buildId: "fixture-a" },
      };
      const app = path.join(options.outputDir, "app");
      if (failure === "receipt") {
        await fs.appendFile(path.join(options.outputDir, "receipt.json"), " ");
      }
      if (failure === "package") {
        verification.portablePackageSha256 = "0".repeat(64);
      }
      if (failure === "runtime") {
        verification.expectedRuntime.buildId = "stale";
      }
      if (failure === "archive") {
        await fs.appendFile(path.join(options.outputDir, "installed-runtime.tgz"), "tamper");
      }
      if (failure === "manifest") {
        await fs.appendFile(path.join(options.outputDir, "installed-runtime.manifest.jsonl"), "\n");
      }
      if (failure === "content") {
        await write(app, "dist/entry.js", "export const changed = true;\n");
      }
      if (failure === "mode") {
        const file = path.join(app, "dist/entry.js");
        await fs.chmod(file, (await fs.stat(file)).mode ^ 0o100);
      }
      if (failure === "link") {
        await fs.symlink(root, path.join(app, "escape"));
      }
      await expect(verifyInstalledRuntimeComposition(verification)).rejects.toThrow(
        failure === "receipt"
          ? /receipt digest/
          : failure === "package"
            ? /composition identity/
            : failure === "runtime"
              ? /runtime identity/
              : ["archive", "manifest"].includes(failure)
                ? /archive\/manifest identity/
                : failure === "link"
                  ? /Unsafe dependency link/
                  : /inventory mismatch/,
      );
    },
  );
  it.each(["portable", "inventory", "identity", "target", "overlap", "escape"])(
    "rejects %s mismatches before publishing a receipt",
    async (failure) => {
      const { root, deps, options } = await fixture();
      if (failure === "portable") {
        await fs.appendFile(options.package, "tamper");
      }
      if (failure === "inventory") {
        await write(deps, "node_modules/external/index.js", "changed\n");
      }
      if (failure === "identity") {
        await write(options.sourceRoot, "pnpm-lock.yaml", "different\n");
      }
      if (failure === "target") {
        options.arch = "arm64";
      }
      if (failure === "overlap") {
        options.outputDir = path.join(deps, "output");
      }
      if (failure === "escape") {
        await fs.symlink(root, path.join(deps, "escape"));
      }
      await expect(composeInstalledRuntime(options)).rejects.toThrow();
      await expect(fs.access(path.join(options.outputDir, "receipt.json"))).rejects.toThrow();
    },
  );
});
