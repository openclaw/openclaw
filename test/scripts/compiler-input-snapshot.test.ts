import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ARTIFACT_CACHE_VERSION } from "../../scripts/lib/build-artifact-cache.mts";
import { CompilerInputSnapshot } from "../../scripts/lib/compiler-input-snapshot.mts";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

function fixture(root = roots.make("compiler-input-snapshot-")) {
  const write = (file: string, bytes: string) => {
    const filename = path.join(root, file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  };
  write("package.json", '{"type":"module"}');
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("base.json", '{"compilerOptions":{"target":"ES2023","types":[]}}');
  write("tsconfig.json", '{"extends":"./base.json","include":["src/**/*.ts"]}');
  write("src/index.ts", "export const value = 1;\n");
  write("tools/compiler.js", "export const compiler = 1;\n");
  write("scripts/generator.mts", "export const generator = 1;\n");
  write("packages/local/package.json", '{"name":"fixture-package","type":"module"}');
  write("packages/local/src/index.ts", "export const dependency = 1;\n");
  write("packages/local/dist/index.js", "export const built = 1;\n");
  write(".cache/vitest/ignored.json", "{}");
  fs.mkdirSync(path.join(root, "node_modules"));
  const link = (target: string, name: string) =>
    fs.symlinkSync(
      path.join(root, target),
      path.join(root, name),
      process.platform === "win32" ? "junction" : "dir",
    );
  // The source alias is visited before the installed alias upgrades this tree.
  link("packages/local", "alias");
  link("packages/local", "node_modules/fixture-package");
  link("packages/local", "packages/local/self");
  const snapshot = () =>
    new CompilerInputSnapshot(root, {
      toolchainFiles: ["tools/compiler.js"],
      generatorInputs: ["package.json", "pnpm-lock.yaml", "scripts/generator.mts"],
      isGeneratorInput: (file) => file.endsWith("/package.json"),
    });
  const signature = (input: CompilerInputSnapshot, outputRoot?: string) =>
    input.signature("tsconfig.json", ["fixture-compiler"], ["src/index.ts"], outputRoot);
  return { root, write, snapshot, signature };
}

it.each([
  ['{"compilerOptions":{"target":"invalid"},"include":["src/**/*.ts"]}', "TS6046"],
  ['{"include":"src/**/*.ts"}', "TS5024"],
  ['{"extends":"./missing.json","include":["src/**/*.ts"]}', "TS5083"],
  ['{"compilerOptions": {', "TS1005"],
])("rejects invalid native compiler configuration %s", (config, diagnostic) => {
  const f = fixture();
  f.write("tsconfig.json", config);
  expect(() => f.signature(f.snapshot())).toThrow(diagnostic);
});

it.each([
  { file: "tools/compiler.js", bytes: "export const compiler = 2;\n" },
  {
    file: "base.json",
    bytes: '{"compilerOptions":{"target":"ES2022","types":[]}}',
  },
  {
    file: "base.json",
    bytes: '{ "compilerOptions": {"target":"ES2023","types":[]} }\n',
  },
  { file: "packages/local/.tmp/package.json", bytes: '{"type":"commonjs"}' },
  { file: "packages/local/package.json", bytes: '{"name":"fixture-package","type":"commonjs"}' },
  { file: "scripts/generator.mts", bytes: "export const generator = 2;\n" },
])("invalidates changed input $file", async ({ file, bytes }) => {
  const f = fixture();
  const before = f.snapshot();
  await before.prepare();
  const original = f.signature(before);
  f.write(file, bytes);
  const after = f.snapshot();
  await after.prepare();
  expect(f.signature(after)).not.toBe(original);
  expect(f.signature(after)).toBe(f.signature(f.snapshot()));
});

it("ignores checkout scratch packages that disappear during preparation", async () => {
  const f = fixture();
  const original = f.signature(f.snapshot());
  const scratch = path.join(f.root, ".tmp", "fixture-package");
  f.write(".tmp/fixture-package/package.json", '{"name":"transient-fixture"}');
  const read = fs.promises.readdir.bind(fs.promises);
  const reader = vi.spyOn(fs.promises, "readdir").mockImplementation(async (...args) => {
    const entries = await read(...args);
    if (args[0] === scratch) {
      fs.rmSync(scratch, { recursive: true });
    }
    return entries;
  });
  try {
    const prepared = f.snapshot();
    await prepared.prepare();
    expect(f.signature(prepared)).toBe(original);
    expect(f.signature(f.snapshot())).toBe(original);
  } finally {
    reader.mockRestore();
  }
});

it("preserves signatures across checkout depths with one shared external dependency", async () => {
  const directory = roots.make("compiler-input-snapshot-portability-");
  const dependency = path.join(directory, "shared-dependency");
  fs.mkdirSync(dependency);
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    '{"name":"shared-dependency","type":"module"}',
  );
  fs.writeFileSync(path.join(dependency, "index.js"), "export const value = 1;\n");
  const signatures: string[] = [];
  for (const root of [path.join(directory, "shallow"), path.join(directory, "deeper/checkout")]) {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      '{"compilerOptions":{"target":"ES2023","types":[]},"include":["src/**/*.ts"]}',
    );
    fs.writeFileSync(
      path.join(root, "src/index.ts"),
      'export { value } from "shared-dependency";\n',
    );
    fs.symlinkSync(
      dependency,
      path.join(root, "node_modules/shared-dependency"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const snapshot = new CompilerInputSnapshot(root, {
      toolchainFiles: [],
      generatorInputs: ["package.json"],
      isGeneratorInput: (file) => file.endsWith("/package.json"),
    });
    await snapshot.prepare();
    signatures.push(
      snapshot.signature("tsconfig.json", [], ["src/index.ts", path.join(dependency, "index.js")]),
    );
  }
  expect(signatures[1]).toBe(signatures[0]);
});

it("invalidates warm records when ancestor installs appear or disappear without reading their contents", async () => {
  const directory = roots.make("compiler-input-snapshot-ancestor-");
  const f = fixture(path.join(directory, "checkout"));
  f.write("dist/index.d.ts", "export declare const value = 1;\n");
  const record = (snapshot: CompilerInputSnapshot) => ({
    version: ARTIFACT_CACHE_VERSION,
    signature: f.signature(snapshot),
    inputs: ["src/index.ts"],
    outputs: { "dist/index.d.ts": snapshot.hash("dist/index.d.ts") },
  });
  const matches = (saved: ReturnType<typeof record>) =>
    f.snapshot().matches(saved, "tsconfig.json", ["fixture-compiler"], ["dist/index.d.ts"]);
  const before = f.snapshot();
  const absent = record(before);
  expect(matches(absent)).toBe(true);

  const install = path.join(directory, "node_modules");
  fs.mkdirSync(install);
  const after = f.snapshot();
  await after.prepare();
  expect(after.matches(absent, "tsconfig.json", ["fixture-compiler"], ["dist/index.d.ts"])).toBe(
    false,
  );
  const present = record(after);
  expect(matches(present)).toBe(true);

  fs.mkdirSync(path.join(install, "external"));
  fs.writeFileSync(path.join(install, "external/package.json"), '{"version":"1.0.0"}');
  expect(matches(present)).toBe(true);
  fs.writeFileSync(path.join(install, "external/package.json"), '{"version":"2.0.0"}');
  expect(matches(present)).toBe(true);

  fs.rmSync(install, { recursive: true });
  expect(matches(present)).toBe(false);
  expect(matches(absent)).toBe(true);
});

it.each(["dependency", "@scope/dependency"])(
  "guards empty local package directory %s before acceptance and warm reuse",
  (name) => {
    const f = fixture();
    const directory = path.join(f.root, "node_modules", name);
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    const record = (snapshot: CompilerInputSnapshot) => ({
      version: ARTIFACT_CACHE_VERSION,
      signature: f.signature(snapshot),
      inputs: ["src/index.ts"],
      outputs: {},
    });
    const before = f.snapshot();
    const absent = record(before);
    fs.mkdirSync(directory);
    const after = f.snapshot();
    const present = record(after);
    expect(after.matches(absent, "tsconfig.json", ["fixture-compiler"], [])).toBe(false);

    fs.rmdirSync(directory);
    const removed = f.snapshot();
    expect(removed.matches(present, "tsconfig.json", ["fixture-compiler"], [])).toBe(false);
    expect(removed.matches(absent, "tsconfig.json", ["fixture-compiler"], [])).toBe(true);
  },
);

it("invalidates an indirect dependency symlink when its final target changes", async () => {
  const f = fixture();
  const outside = roots.make("compiler-input-snapshot-targets-");
  const first = path.join(outside, "first");
  const second = path.join(outside, "second");
  for (const [directory, value] of [
    [first, "first"],
    [second, "second"],
  ] as const) {
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, "package.json"),
      '{"name":"external-fixture","type":"module"}',
    );
    fs.writeFileSync(path.join(directory, "source.js"), `export const value = "${value}";\n`);
  }
  const indirect = path.join(outside, "indirect");
  const installed = path.join(f.root, "node_modules/external-fixture");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(first, indirect, linkType);
  fs.symlinkSync(indirect, installed, linkType);
  const originalLink = fs.readlinkSync(installed);
  const inputs = [path.join(first, "source.js")];
  const before = f.snapshot();
  await before.prepare();
  const original = before.signature("tsconfig.json", [], inputs);

  fs.unlinkSync(indirect);
  fs.symlinkSync(second, indirect, linkType);
  const after = f.snapshot();
  await after.prepare();

  expect(fs.readlinkSync(installed)).toBe(originalLink);
  expect(fs.readFileSync(path.join(installed, "source.js"), "utf8")).toContain('"second"');
  expect(fs.readFileSync(inputs[0]!, "utf8")).toContain('"first"');
  expect(after.signature("tsconfig.json", [], inputs)).not.toBe(original);
});

it("preloads sibling subtrees while the ordered visitor waits on a deeper directory", async ({
  signal,
  onTestFinished,
}) => {
  const testRoots = useAutoCleanupTempDirTracker(onTestFinished);
  const f = fixture(testRoots.make("compiler-input-snapshot-preparation-"));
  f.write("fanout/a/deeper/input.ts", "export {};\n");
  f.write("fanout/b/deeper/input.ts", "export {};\n");
  f.write(".artifacts/ignored/input.ts", "export {};\n");
  const held = path.join(f.root, "fanout/a/deeper");
  const sibling = path.join(f.root, "fanout/b/deeper");
  const heldStarted = createDeferred();
  const siblingStarted = createDeferred();
  const release = createDeferred();
  const read = fs.promises.readdir.bind(fs.promises);
  const observed = new Set<string>();
  let active = 0;
  let peak = 0;
  const reader = vi.spyOn(fs.promises, "readdir").mockImplementation(async (...args) => {
    observed.add(String(args[0]));
    active += 1;
    peak = Math.max(peak, active);
    try {
      const entries = await read(...args);
      if (args[0] === held) {
        heldStarted.resolve();
        await release.promise;
      } else if (args[0] === sibling) {
        siblingStarted.resolve();
      }
      return entries;
    } finally {
      active -= 1;
    }
  });
  const snapshot = f.snapshot();
  const preparation = snapshot.prepare();
  let cleanup: Promise<void> | undefined;
  const finishPreparation = () =>
    (cleanup ??= (async () => {
      release.resolve();
      try {
        await preparation;
      } finally {
        reader.mockRestore();
      }
    })());
  // Vitest runs these hooks in reverse order, after afterEach: join before removing inputs.
  onTestFinished(finishPreparation);
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        Promise.all([heldStarted.promise, siblingStarted.promise]),
        preparation,
        "preparation serialized the independent directory subtrees",
      ),
      signal,
    );
    expect(peak).toBeLessThanOrEqual(16);
  } finally {
    await finishPreparation();
  }
  expect(active).toBe(0);
  expect(observed.has(path.join(f.root, ".artifacts"))).toBe(false);
  expect(observed.has(path.join(f.root, ".cache/vitest"))).toBe(false);
  const synchronous = f.snapshot();
  for (const outputRoot of [undefined, path.join(f.root, "packages/local/dist")]) {
    expect(f.signature(snapshot, outputRoot)).toBe(f.signature(synchronous, outputRoot));
  }
});
