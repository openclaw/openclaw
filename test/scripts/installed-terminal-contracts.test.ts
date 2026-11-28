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
  collectInstalledTerminalApplication,
  prepareInstalledTerminalApplication,
  readInstalledTerminalDependencyTree,
  readInstalledTerminalMetadata,
  readInstalledTerminalReference,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-contracts.mjs";
import {
  extractInstalledTerminalCachedPackage,
  inspectInstalledTerminalDependencyNodes,
  type InstalledTerminalDependencyReference,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-dependencies.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

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

it("binds the current CLI's complete reference including reviewed and source-locked alternatives", () => {
  const output = path.join(dirs.make("installed-current-reference-"), "reference.json");
  const result = runProcess(
    resolveTestNodeExecPath(),
    ["scripts/e2e/lib/upgrade-survivor/installed-terminal-reference.mts", "current", output],
    { ...process.env, OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: process.cwd() },
    10_000,
  );
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  const encoded = stableStringify(report.reference);
  expect(report.sha256).toBe(hash(Buffer.from(encoded)));
  const reference = readInstalledTerminalReference("current", encoded);
  expect(reference.packages).toMatchObject({
    "brace-expansion@5.0.13": {
      resolution: {
        integrity:
          "sha512-Vh3dmFbc4wZeox7M9I/0L9GfFd83Su4+yCck/OF9Gi/P/dAHn0RT7X4K9R7gMNMhDck3DvhR6QXsnQdjjgwNvQ==",
      },
    },
    "@acemir/cssom@0.9.33": {
      resolution: {
        integrity:
          "sha512-52IMmrBsIsDZLp/KFM+KmaMLJ8GTj113K+iFGFCoOjstZSZbsAxMJE8KYtwao7bz1LsEG810ts1m5wvkVEqPlg==",
      },
    },
  });
  for (const key of ["brace-expansion@5.0.12", "@acemir/cssom@0.9.32"]) {
    expect(reference.packages[key]?.resolution.integrity).toMatch(/^sha512-/u);
  }
  for (const relative of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const bytes = fs.readFileSync(relative);
    expect(report.inputs[relative]).toEqual({ bytes: bytes.length, sha256: hash(bytes) });
  }
});

function applicationRootsFixture() {
  const roots: Array<[string, number, string]> = [
    [
      "dist/infra/sqlite-readonly-location.worker.js",
      153814,
      "cc5b8b1224664334efd99d859c6bfb23de3f3078f2a56764758d5a4a3591087c",
    ],
    [
      "dist/logging/logger-file.worker.js",
      56642,
      "f1a637023f9baf6e4246997c09dcf7f0b6b9f9939c694a28871adef3ba3685e9",
    ],
  ];
  return {
    identity: {
      version: "1.0.0",
      buildInfo: {},
      files: Object.fromEntries(roots.map(([file, size, sha256]) => [file, { size, sha256 }])),
    },
    prepared: {
      roles: {
        "sqlite-session": {
          sha256: "3aaba32291b3a62634df8d3ced331b77e80ea5db085226672b1010930aa44460",
          files: roots,
        },
      },
      assets: [],
      metadata: {
        version: "1.0.0",
        build: {},
        files: {},
        schemaVersions: { state: 40, agent: 42 },
      },
    },
  };
}

it("rejects a freshly self-certified or omitted application closure", () => {
  const fixture = applicationRootsFixture();
  // Valid root identities do not let a caller certify an empty or partial closure.
  for (const files of [[], fixture.prepared.roles["sqlite-session"].files.slice(0, 1)]) {
    fixture.prepared.roles["sqlite-session"].files = files;
    fixture.prepared.roles["sqlite-session"].sha256 = hash(Buffer.from(JSON.stringify(files)));
    expect(() => assertInstalledTerminalApplication(fixture.identity, fixture.prepared)).toThrow(
      "Unreviewed sqlite-session closure",
    );
  }
});

it.each(["missing", "changed"])("refuses a %s manifest-launched worker root", async (change) => {
  const fixture = applicationRootsFixture();
  const root = "dist/logging/logger-file.worker.js";
  if (change === "missing") {
    delete fixture.identity.files[root];
  } else {
    fixture.identity.files[root] = { size: 56642, sha256: "0".repeat(64) };
  }
  expect(() => assertInstalledTerminalApplication(fixture.identity, fixture.prepared)).toThrow(
    "Additional application root changed",
  );
  await expect(
    prepareInstalledTerminalApplication(dirs.make("installed-contract-roots-"), fixture.identity),
  ).rejects.toThrow("Additional application root changed");
});

it("traverses the additional worker's real static closure under its verified package scope", async () => {
  const root = path.join(fs.realpathSync(dirs.make("installed-contract-closure-")), "prefix/app");
  const sources: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "openclaw",
      version: "1.0.0",
      type: "module",
      openclaw: { schemaVersions: { state: 40, agent: 42 } },
    }),
    "dist/build-info.json": JSON.stringify({ version: "1.0.0", commit: "1".repeat(40) }),
    "dist/infra/entry.js": "export {};\n",
    "dist/logging/logger-file.worker.js":
      "import { write } from './writer.js'; export { write };\n",
    "dist/logging/writer.js": "export const write = () => {};\n",
  };
  const files: Record<string, { size: number; sha256: string }> = {};
  const put = (relative: string, source: string) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), source);
    files[relative] = { size: Buffer.byteLength(source), sha256: hash(Buffer.from(source)) };
  };
  for (const [relative, source] of Object.entries(sources)) put(relative, source);
  const identity = {
    version: "1.0.0",
    buildInfo: JSON.parse(sources["dist/build-info.json"]!),
    files,
  };
  const selected = [
    "dist/infra/entry.js",
    "dist/logging/logger-file.worker.js",
    "dist/logging/writer.js",
  ];
  const expectedFiles = selected.map((file) => [file, files[file]!.size, files[file]!.sha256]);
  const contract = {
    entry: selected[0]!,
    entrySha256: files[selected[0]!]!.sha256,
    additionalRoots: { [selected[1]!]: files[selected[1]!]!.sha256 },
    dynamic: {},
    sha256: hash(Buffer.from(JSON.stringify(expectedFiles))),
  };
  const collect = () =>
    collectInstalledTerminalApplication(root, identity, { fixture: contract }, {});
  expect((await collect()).roles.fixture?.files).toEqual(expectedFiles);
  // Fixture contracts exercise the same physical traversal; the public admission
  // still rejects them because its production roots and digests are fixed.
  await expect(prepareInstalledTerminalApplication(root, identity)).rejects.toThrow();
  fs.unlinkSync(path.join(root, selected[2]!));
  await expect(collect()).rejects.toThrow();
  put(selected[2]!, sources[selected[2]!]! + "export const changed = true;\n");
  await expect(collect()).rejects.toThrow("Unreviewed fixture closure");
  put(selected[2]!, sources[selected[2]!]!);
  expect((await collect()).roles.fixture?.files).toEqual(expectedFiles);
  put("dist/logging/package.json", JSON.stringify({ type: "commonjs" }));
  await expect(collect()).rejects.toThrow(SyntaxError);
  for (const manifest of [{ type: "module" }, {}]) {
    put("dist/logging/package.json", JSON.stringify(manifest));
    expect((await collect()).roles.fixture?.files).toEqual(expectedFiles);
  }
  fs.writeFileSync(path.join(root, "dist/logging/package.json"), '{"type":"commonjs"}');
  await expect(collect()).rejects.toThrow();
});

it("binds finite initialization metadata and refuses foreign, changed or oversized candidates", () => {
  // Keep both ancestor candidates inside this fixture, below the runner package scope.
  const parent = path.join(fs.realpathSync(dirs.make("installed-contract-metadata-")), "prefix");
  const root = path.join(parent, "app");
  fs.mkdirSync(path.join(root, "dist/infra"), { recursive: true });
  const build = { version: "1.0.0", commit: "1".repeat(40), buildId: "fixture" };
  const manifest = {
    name: "openclaw",
    version: "1.0.0",
    openclaw: { schemaVersions: { state: 40, agent: 42 } },
  };
  writeJson(path.join(root, "package.json"), manifest);
  writeJson(path.join(root, "dist/build-info.json"), build);
  const files: Record<string, { size: number; sha256: string }> = {};
  for (const file of ["package.json", "dist/build-info.json"]) {
    const bytes = fs.readFileSync(path.join(root, file));
    files[file] = { size: bytes.length, sha256: hash(bytes) };
  }
  const identity = { version: "1.0.0", buildInfo: build, files };
  const result = readInstalledTerminalMetadata(root, identity);
  expect(result.build).toEqual(build);
  expect(result.schemaVersions).toEqual({ state: 40, agent: 42 });
  for (const schemaVersions of [
    { state: 20, agent: 25 },
    { state: 41, agent: 43 },
  ]) {
    writeJson(path.join(root, "package.json"), { ...manifest, openclaw: { schemaVersions } });
    expect(() => readInstalledTerminalMetadata(root, identity)).toThrow();
    const bytes = fs.readFileSync(path.join(root, "package.json"));
    files["package.json"] = { size: bytes.length, sha256: hash(bytes) };
    expect(readInstalledTerminalMetadata(root, identity).schemaVersions).toEqual(schemaVersions);
  }
  for (const schemaVersions of [
    undefined,
    { state: 40 },
    { state: "40", agent: 42 },
    { state: 40, agent: -1 },
    { state: 40.5, agent: 42 },
  ]) {
    writeJson(path.join(root, "package.json"), { ...manifest, openclaw: { schemaVersions } });
    const bytes = fs.readFileSync(path.join(root, "package.json"));
    files["package.json"] = { size: bytes.length, sha256: hash(bytes) };
    expect(() => readInstalledTerminalMetadata(root, identity)).toThrow(
      "Invalid package schema version",
    );
  }
  writeJson(path.join(root, "package.json"), manifest);
  const manifestBytes = fs.readFileSync(path.join(root, "package.json"));
  files["package.json"] = { size: manifestBytes.length, sha256: hash(manifestBytes) };
  expect(readInstalledTerminalMetadata(root, identity)).toEqual(result);
  expect(result.files["dist/infra/package.json"]).toBeNull();
  expect(result.files["dist/infra/build-info.json"]).toBeNull();
  fs.mkdirSync(path.join(root, "dist/state"));
  fs.mkdirSync(path.join(root, "dist/logging"));
  for (const relative of [
    "dist/state/package.json",
    "dist/state/build-info.json",
    "dist/state/.buildstamp",
    "dist/state/.runtime-postbuildstamp",
    "dist/logging/package.json",
  ]) {
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
  const packageAt = (relative: string, manifest: Record<string, unknown> = {}) => {
    const directory = path.join(root, relative);
    fs.mkdirSync(directory, { recursive: true });
    writeJson(path.join(directory, "package.json"), {
      name: path.basename(directory),
      version: "1.0.0",
      ...manifest,
    });
    fs.writeFileSync(path.join(directory, "index.js"), "module.exports = {};\n");
    return directory;
  };
  packageAt("", { dependencies: { demo: "1.0.0", linkedom: "0.18.14" } });
  packageAt("node_modules/demo", {
    dependencies: { "brace-expansion": "^5.0.8" },
    optionalDependencies: { "demo-native": "1.0.0", "absent-platform-fixture": "1.0.0" },
    bin: { foo: "index.js", bar: "other.js" },
  });
  fs.writeFileSync(path.join(modules, "demo/other.js"), "module.exports = 1;\n");
  const brace = (version: string) =>
    packageAt("node_modules/demo/node_modules/brace-expansion", {
      version,
    });
  brace("5.0.13");
  packageAt("node_modules/linkedom", {
    version: "0.18.14",
    dependencies: { "@acemir/cssom": "^0.9.32" },
  });
  const cssom = (version: string) =>
    packageAt("node_modules/linkedom/node_modules/@acemir/cssom", {
      name: "@acemir/cssom",
      version,
    });
  cssom("0.9.32");
  packageAt("node_modules/demo-native");
  fs.mkdirSync(path.join(modules, ".bin"));
  fs.symlinkSync("../demo/index.js", path.join(modules, ".bin/foo"));
  fs.symlinkSync("../demo/other.js", path.join(modules, ".bin/bar"));
  const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  const reference: InstalledTerminalDependencyReference = {
    policy: { dependencies: { demo: "1.0.0", linkedom: "0.18.14" } },
    requiredPackages: { "demo-native": "1.0.0" },
    packages: Object.fromEntries(
      [
        "demo@1.0.0",
        "brace-expansion@5.0.13",
        "demo-native@1.0.0",
        "linkedom@0.18.14",
        "@acemir/cssom@0.9.32",
      ].map((key) => [key, { resolution: { integrity } }]),
    ),
  };
  const load = async () => {
    // The repository's bundled npm supplies real native placements and errors.
    // This exercises the adapter, not the separate image npm-version admission.
    const npmRequire = createRequire(createRequire(import.meta.url).resolve("npm/package.json"));
    const Arborist = npmRequire("@npmcli/arborist");
    const tree = await new Arborist({ path: prefix, global: true, forceActual: true }).loadActual();
    const application = tree.children.get("openclaw");
    const roots = Object.keys(reference.policy.dependencies);
    const nodes = await application.querySelectorAll(
      roots.map((name) => `:scope > [name="${name}"], :scope > [name="${name}"] *`).join(", "),
    );
    return { application, nodes };
  };
  const inspect = async () => {
    const { application, nodes } = await load();
    return inspectInstalledTerminalDependencyNodes(
      application,
      nodes,
      Object.keys(reference.policy.dependencies),
      reference,
    );
  };
  return { root, modules, packageAt, brace, cssom, reference, load, inspect };
}

it("uses native global placements, retains direct specs and refuses changed root policy", async () => {
  const fixture = dependencyFixture();
  const result = await fixture.inspect();
  expect(result.packages.map((entry) => entry.key).toSorted()).toEqual([
    "@acemir/cssom@0.9.32",
    "brace-expansion@5.0.13",
    "demo-native@1.0.0",
    "demo@1.0.0",
    "linkedom@0.18.14",
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
  fixture.brace("5.0.14");
  await expect(fixture.inspect()).rejects.toThrow("Dependency is outside the reviewed reference");
  fixture.brace("5.0.13");
  fixture.cssom("0.9.33");
  await expect(fixture.inspect()).rejects.toThrow("Dependency is outside the reviewed reference");
  const integrity =
    "sha512-52IMmrBsIsDZLp/KFM+KmaMLJ8GTj113K+iFGFCoOjstZSZbsAxMJE8KYtwao7bz1LsEG810ts1m5wvkVEqPlg==";
  fixture.reference.packages["@acemir/cssom@0.9.33"] = { resolution: { integrity } };
  const renewed = await fixture.inspect();
  expect(renewed.packages.find((entry) => entry.key === "@acemir/cssom@0.9.33")?.integrity).toBe(
    integrity,
  );
  expect(renewed.edges).toContainEqual({
    from: "linkedom",
    name: "@acemir/cssom",
    spec: "^0.9.32",
    type: "prod",
    to: "linkedom/node_modules/@acemir/cssom",
    optionalAbsent: false,
  });
  fixture.cssom("0.9.34");
  await expect(fixture.inspect()).rejects.toThrow("Dependency is outside the reviewed reference");
  fixture.cssom("0.9.32");
  fixture.packageAt("", { dependencies: { demo: "^1.0.0", linkedom: "0.18.14" } });
  await expect(fixture.inspect()).rejects.toThrow("Selected direct dependency spec changed");
});

it("refuses missing required native targets and invalid or omitted dependency edges", async () => {
  const fixture = dependencyFixture();
  fs.rmSync(path.join(fixture.modules, "demo-native"), { recursive: true });
  await expect(fixture.inspect()).rejects.toThrow("Required selected platform package is absent");
  fixture.packageAt("node_modules/demo-native");
  fs.rmSync(path.join(fixture.modules, "demo/node_modules/brace-expansion"), { recursive: true });
  await expect(fixture.inspect()).rejects.toThrow("Invalid native dependency edge");
  fixture.brace("6.0.0");
  await expect(fixture.inspect()).rejects.toThrow("Invalid native dependency edge");
  fixture.brace("5.0.13");
  fs.rmSync(path.join(fixture.modules, "linkedom/node_modules/@acemir/cssom"), {
    recursive: true,
  });
  await expect(fixture.inspect()).rejects.toThrow("Invalid native dependency edge");
  fixture.cssom("0.10.0");
  await expect(fixture.inspect()).rejects.toThrow("Invalid native dependency edge");
  fixture.cssom("0.9.32");
  const { application, nodes } = await fixture.load();
  expect(() =>
    inspectInstalledTerminalDependencyNodes(
      application,
      nodes.filter((node: { name: string }) => node.name !== "brace-expansion"),
      Object.keys(fixture.reference.policy.dependencies),
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
  fixture.packageAt("node_modules/demo/node_modules/brace-expansion", {
    version: "5.0.13",
    dependencies: { "demo-native": "1.0.0" },
  });
  fixture.packageAt("node_modules/demo/node_modules/brace-expansion/node_modules/demo-native");
  await expect(fixture.inspect()).rejects.toThrow("Required platform edge does not resolve");
});
