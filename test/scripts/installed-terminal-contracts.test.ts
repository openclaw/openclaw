import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { stableStringify } from "../../packages/normalization-core/src/stable-stringify.js";
import { capturePackageTree } from "../../scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs";
import {
  assertInstalledTerminalApplication,
  assertInstalledTerminalDependencyTree,
  readInstalledTerminalDependencyTree,
  readInstalledTerminalMetadata,
  readInstalledTerminalReference,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-contracts.mjs";
import {
  extractInstalledTerminalCachedPackage,
  inspectInstalledTerminalDependencyNodes,
  type InstalledTerminalDependencyReference,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-dependencies.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJson } from "./upgrade-survivor-shard.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it("extracts exact cached content without packuments and refuses wrong, missing or corrupt content", async () => {
  const root = fs.realpathSync(dirs.make("installed-contract-cache-"));
  const manifest = createRequire(import.meta.url).resolve("npm/package.json");
  const npmCli = path.join(path.dirname(manifest), "bin/npm-cli.js");
  const npmRequire = createRequire(npmCli);
  const cacache = npmRequire("cacache");
  const tar = npmRequire("tar");
  const { flatten } = npmRequire("@npmcli/config/lib/definitions");
  const cache = path.join(root, "npm-cache");
  const contentCache = flatten({ cache }).cache;
  expect(contentCache).toBe(path.join(cache, "_cacache"));
  const source = path.join(root, "source/package");
  fs.mkdirSync(source, { recursive: true });
  writeJson(path.join(source, "package.json"), {
    name: "cache-only-fixture",
    version: "1.0.0",
    scripts: { prepare: "exit 97", install: "exit 98" },
  });
  fs.writeFileSync(path.join(source, "index.js"), "throw new Error('must not execute');\n");
  const original = path.join(root, "original.tgz");
  await tar.c({ gzip: true, file: original, cwd: path.dirname(source) }, ["package"]);
  const bytes = fs.readFileSync(original);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  await cacache.put(contentCache, "fixture-content-only", bytes, { integrity });
  await cacache.rm.entry(contentCache, "fixture-content-only");
  expect(await cacache.ls(contentCache)).toEqual({});
  const extract = (label: string, selectedCache = cache, selectedIntegrity = integrity) => {
    const directory = path.join(root, label);
    fs.mkdirSync(directory);
    return extractInstalledTerminalCachedPackage({
      npmCli,
      cache: selectedCache,
      integrity: selectedIntegrity,
      directory,
    });
  };
  const unpacked = await extract("accepted");
  expect(fs.readFileSync(path.join(unpacked, "index.js"))).toEqual(
    fs.readFileSync(path.join(source, "index.js")),
  );
  await expect(extract("wrong-root", path.join(root, "wrong-cache"))).rejects.toThrow(
    "content is absent",
  );
  await expect(
    extract("missing", cache, `sha512-${Buffer.alloc(64).toString("base64")}`),
  ).rejects.toThrow("content is absent");
  const cached = capturePackageTree(contentCache).filter(
    (row) => row.kind === "file" && row.path.startsWith(`content-v2${path.sep}`),
  );
  expect(cached).toHaveLength(1);
  const cachedFile = cached[0];
  assert.isDefined(cachedFile);
  fs.writeFileSync(path.join(contentCache, cachedFile.path), Buffer.alloc(bytes.length));
  await expect(extract("corrupt")).rejects.toThrow("Canonical package SRI changed");
  expect(fs.existsSync(path.join(root, "corrupt/package"))).toBe(false);
});

it("compares complete independent dependency trees and binds every link hop", () => {
  const root = fs.realpathSync(dirs.make("installed-contract-tree-"));
  const first = path.join(root, "first/node_modules");
  const second = path.join(root, "second/node_modules");
  fs.mkdirSync(path.join(first, "pkg"), { recursive: true });
  fs.mkdirSync(path.join(first, ".bin"));
  fs.writeFileSync(path.join(first, "pkg/main.js"), "export {};\n");
  fs.writeFileSync(path.join(first, "pkg/shared.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(first, ".package-lock.json"), "{}\n");
  fs.symlinkSync("../pkg/main.js", path.join(first, ".bin/demo"));
  fs.cpSync(first, second, { recursive: true, verbatimSymlinks: true });
  const original = readInstalledTerminalDependencyTree(first);
  const copied = readInstalledTerminalDependencyTree(second);
  expect(copied.identity).not.toBe(original.identity);
  expect(copied.sha256).toBe(original.sha256);
  expect(assertInstalledTerminalDependencyTree(path.dirname(second), original).sha256).toBe(
    original.sha256,
  );
  fs.writeFileSync(path.join(second, "pkg/shared.js"), "export const value = 2;\n");
  expect(readInstalledTerminalDependencyTree(second).sha256).not.toBe(original.sha256);
  expect(() => assertInstalledTerminalDependencyTree(path.dirname(second), original)).toThrow(
    "Staged dependency tree changed",
  );
  fs.copyFileSync(path.join(first, "pkg/shared.js"), path.join(second, "pkg/shared.js"));
  fs.writeFileSync(path.join(second, ".package-lock.json"), '{"changed":true}\n');
  expect(readInstalledTerminalDependencyTree(second).sha256).not.toBe(original.sha256);

  const link = path.join(second, ".bin/demo");
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(first, "pkg/main.js"), link);
  expect(() => readInstalledTerminalDependencyTree(second)).toThrow("before resolving");
  fs.unlinkSync(link);
  const returning = path.join(root, "return-link");
  fs.symlinkSync(path.join(second, "pkg/main.js"), returning);
  fs.symlinkSync(returning, link);
  expect(fs.realpathSync(link)).toBe(path.join(second, "pkg/main.js"));
  expect(() => readInstalledTerminalDependencyTree(second)).toThrow("before resolving");
});

it("binds the fixed historical allowed closure independently of diagnostic overrides", () => {
  const report: { reference: unknown; provenance: unknown } = JSON.parse(
    fs.readFileSync("test/fixtures/installed-terminal-historical-reference.json", "utf8"),
  );
  const encoded = stableStringify(report.reference);
  const reference = readInstalledTerminalReference("historical", encoded);
  expect(Object.keys(reference.packages)).toHaveLength(47);
  expect(reference.requiredPackages).toEqual({ "@openclaw/fs-safe-linux-x64-gnu": "0.26.0" });
  report.provenance = { overrides: { unrelated: "changed" } };
  expect(readInstalledTerminalReference("historical", stableStringify(report.reference))).toEqual(
    reference,
  );
  expect(() => readInstalledTerminalReference("current", encoded)).toThrow(
    "Unreviewed dependency reference",
  );
  reference.policy.dependencies.chalk = "changed";
  expect(() => readInstalledTerminalReference("historical", stableStringify(reference))).toThrow(
    "Unreviewed dependency reference",
  );
});

it("rejects a freshly self-certified application closure", () => {
  expect(() =>
    assertInstalledTerminalApplication(
      { version: "1.0.0", buildInfo: {}, files: {} },
      {
        roles: {
          "sqlite-session": {
            sha256: "73e725f0ee31c0835be61bd11e358ef1a6d3412b6198e6b162792c21d3d9c5a6",
            files: [],
          },
        },
        assets: [],
        metadata: { version: "1.0.0", build: {}, files: {} },
      },
    ),
  ).toThrow("Unreviewed sqlite-session closure");
});

it("binds finite initialization metadata and refuses foreign, changed or oversized candidates", () => {
  // Keep both ancestor candidates inside this fixture, below the runner package scope.
  const parent = path.join(fs.realpathSync(dirs.make("installed-contract-metadata-")), "prefix");
  const root = path.join(parent, "app");
  fs.mkdirSync(path.join(root, "dist/infra"), { recursive: true });
  const build = { version: "1.0.0", commit: "1".repeat(40), buildId: "fixture" };
  writeJson(path.join(root, "package.json"), { name: "openclaw", version: "1.0.0" });
  writeJson(path.join(root, "dist/build-info.json"), build);
  const files: Record<string, { size: number; sha256: string }> = {};
  for (const file of ["package.json", "dist/build-info.json"]) {
    const bytes = fs.readFileSync(path.join(root, file));
    files[file] = { size: bytes.length, sha256: hash(bytes) };
  }
  const identity = { version: "1.0.0", buildInfo: build, files };
  const result = readInstalledTerminalMetadata(root, identity);
  expect(result.build).toEqual(build);
  expect(result.files["dist/infra/package.json"]).toBeNull();
  expect(result.files["dist/infra/build-info.json"]).toBeNull();
  fs.mkdirSync(path.join(root, "dist/state"));
  for (const name of [
    "package.json",
    "build-info.json",
    ".buildstamp",
    ".runtime-postbuildstamp",
  ]) {
    const relative = `dist/state/${name}`;
    const file = path.join(root, relative);
    expect(result.files[relative], relative).toBeNull();
    const bytes = Buffer.from("{}\n");
    fs.writeFileSync(file, bytes);
    expect(() => readInstalledTerminalMetadata(root, identity), relative).toThrow("Uninventoried");
    files[relative] = { size: bytes.length, sha256: hash(bytes) };
    expect(readInstalledTerminalMetadata(root, identity).files[relative], relative).toBe(
      hash(bytes),
    );
    fs.appendFileSync(file, " ");
    expect(() => readInstalledTerminalMetadata(root, identity), relative).toThrow();
    fs.unlinkSync(file);
    if (process.platform !== "win32") {
      fs.symlinkSync("../build-info.json", file);
      expect(() => readInstalledTerminalMetadata(root, identity), relative).toThrow();
      fs.unlinkSync(file);
    }
    delete files[relative];
  }
  for (const relative of ["../package.json", "../../package.json"]) {
    expect(result.files[relative], relative).toBeNull();
    const file = path.resolve(root, relative);
    writeJson(file, { version: "foreign" });
    expect(() => readInstalledTerminalMetadata(root, identity), relative).toThrow("Uninventoried");
    fs.unlinkSync(file);
  }
  fs.appendFileSync(path.join(root, "dist/build-info.json"), " ");
  expect(() => readInstalledTerminalMetadata(root, identity)).toThrow();
  writeJson(path.join(root, "dist/build-info.json"), build);
  const candidate = "dist/infra/package.json";
  fs.writeFileSync(path.join(root, candidate), "x".repeat(4 * 1024 * 1024 + 1));
  files[candidate] = { size: 4 * 1024 * 1024 + 1, sha256: "unread" };
  expect(() => readInstalledTerminalMetadata(root, identity)).toThrow();
});

function dependencyFixture() {
  const prefix = fs.realpathSync(dirs.make("installed-contract-native-"));
  const root = path.join(prefix, "node_modules/openclaw");
  const modules = path.join(root, "node_modules");
  const packageAt = (relative: string, manifest: Record<string, unknown>) => {
    const directory = path.join(root, relative);
    fs.mkdirSync(directory, { recursive: true });
    writeJson(path.join(directory, "package.json"), manifest);
    fs.writeFileSync(path.join(directory, "index.js"), "module.exports = {};\n");
    return directory;
  };
  packageAt("", { name: "openclaw", version: "1.0.0", dependencies: { demo: "1.0.0" } });
  packageAt("node_modules/demo", {
    name: "demo",
    version: "1.0.0",
    dependencies: { leaf: "1.0.0" },
    optionalDependencies: { "demo-native": "1.0.0", "absent-platform-fixture": "1.0.0" },
    bin: { foo: "index.js", bar: "other.js" },
  });
  fs.writeFileSync(path.join(modules, "demo/other.js"), "module.exports = 1;\n");
  packageAt("node_modules/demo/node_modules/leaf", { name: "leaf", version: "1.0.0" });
  packageAt("node_modules/demo-native", { name: "demo-native", version: "1.0.0" });
  fs.mkdirSync(path.join(modules, ".bin"));
  fs.symlinkSync("../demo/index.js", path.join(modules, ".bin/foo"));
  fs.symlinkSync("../demo/other.js", path.join(modules, ".bin/bar"));
  const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  const reference: InstalledTerminalDependencyReference = {
    policy: { dependencies: { demo: "1.0.0" } },
    requiredPackages: { "demo-native": "1.0.0" },
    packages: Object.fromEntries(
      ["demo", "leaf", "demo-native"].map((name) => [
        `${name}@1.0.0`,
        { resolution: { integrity } },
      ]),
    ),
  };
  const load = async () => {
    // The repository's bundled npm supplies real native placements and errors.
    // This exercises the adapter, not the separate image npm-version admission.
    const npmRequire = createRequire(createRequire(import.meta.url).resolve("npm/package.json"));
    const Arborist = npmRequire("@npmcli/arborist");
    const tree = await new Arborist({ path: prefix, global: true, forceActual: true }).loadActual();
    const application = tree.children.get("openclaw");
    const nodes = await application.querySelectorAll(
      ':scope > [name="demo"], :scope > [name="demo"] *',
    );
    return { application, nodes };
  };
  const inspect = async () => {
    const { application, nodes } = await load();
    return inspectInstalledTerminalDependencyNodes(application, nodes, ["demo"], reference);
  };
  return { root, modules, packageAt, reference, load, inspect };
}

it("uses native global placements, retains direct specs and refuses changed root policy", async () => {
  const fixture = dependencyFixture();
  const result = await fixture.inspect();
  expect(result.packages.map((entry) => entry.key).toSorted()).toEqual([
    "demo-native@1.0.0",
    "demo@1.0.0",
    "leaf@1.0.0",
  ]);
  expect(result.edges).toContainEqual({
    from: ".",
    name: "demo",
    spec: "1.0.0",
    type: "prod",
    to: "demo",
    optionalAbsent: false,
  });
  expect(result.edges.find((edge) => edge.name === "absent-platform-fixture")?.optionalAbsent).toBe(
    true,
  );
  writeJson(path.join(fixture.root, "package.json"), {
    name: "openclaw",
    version: "1.0.0",
    dependencies: { demo: "^1.0.0" },
  });
  await expect(fixture.inspect()).rejects.toThrow("Selected direct dependency spec changed");
});

it("refuses missing required native targets and invalid or omitted dependency edges", async () => {
  const fixture = dependencyFixture();
  fs.rmSync(path.join(fixture.modules, "demo-native"), { recursive: true });
  await expect(fixture.inspect()).rejects.toThrow("Required selected platform package is absent");
  fixture.packageAt("node_modules/demo-native", { name: "demo-native", version: "1.0.0" });
  fixture.packageAt("node_modules/demo/node_modules/leaf", { name: "leaf", version: "2.0.0" });
  await expect(fixture.inspect()).rejects.toThrow("Invalid native dependency edge");
  fixture.packageAt("node_modules/demo/node_modules/leaf", { name: "leaf", version: "1.0.0" });
  const { application, nodes } = await fixture.load();
  expect(() =>
    inspectInstalledTerminalDependencyNodes(
      application,
      nodes.filter((node: { name: string }) => node.name !== "leaf"),
      ["demo"],
      fixture.reference,
    ),
  ).toThrow("Native dependency closure is incomplete");
});

it("refuses swapped npm bin targets even when both executables belong to the package", async () => {
  const fixture = dependencyFixture();
  await fixture.inspect();
  for (const [key, target] of [
    ["foo", "other.js"],
    ["bar", "index.js"],
  ] as const) {
    const link = path.join(fixture.modules, ".bin", key);
    fs.unlinkSync(link);
    fs.symlinkSync(`../demo/${target}`, link);
  }
  await expect(fixture.inspect()).rejects.toThrow("exact package entry");
});

it("requires the native addon to resolve from its owner, not another private placement", async () => {
  const fixture = dependencyFixture();
  fs.rmSync(path.join(fixture.modules, "demo-native"), { recursive: true });
  fixture.packageAt("node_modules/demo/node_modules/leaf", {
    name: "leaf",
    version: "1.0.0",
    dependencies: { "demo-native": "1.0.0" },
  });
  fixture.packageAt("node_modules/demo/node_modules/leaf/node_modules/demo-native", {
    name: "demo-native",
    version: "1.0.0",
  });
  await expect(fixture.inspect()).rejects.toThrow("Required platform edge does not resolve");
});
