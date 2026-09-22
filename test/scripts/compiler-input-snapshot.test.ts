import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CompilerInputSnapshot } from "../../scripts/lib/compiler-input-snapshot.mts";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = roots.make("compiler-input-snapshot-");
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

it("prepares the same ordered source and installed-alias namespace as synchronous readers", async () => {
  const f = fixture();
  const synchronous = f.snapshot();
  const prepared = f.snapshot();
  await prepared.prepare();
  for (const outputRoot of [undefined, path.join(f.root, "packages/local/dist")]) {
    expect(f.signature(prepared, outputRoot)).toBe(f.signature(synchronous, outputRoot));
  }
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

it("preloads sibling subtrees while the ordered visitor waits on a deeper directory", async () => {
  const f = fixture();
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
  try {
    await withTestTimeout(
      Promise.all([heldStarted.promise, siblingStarted.promise]),
      5_000,
      "preparation serialized the independent directory subtrees",
    );
    expect(peak).toBeLessThanOrEqual(16);
  } finally {
    release.resolve();
    try {
      await preparation;
    } finally {
      reader.mockRestore();
    }
  }
  expect(active).toBe(0);
  expect(observed.has(path.join(f.root, ".artifacts"))).toBe(false);
  expect(observed.has(path.join(f.root, ".cache/vitest"))).toBe(false);
  expect(f.signature(snapshot)).toBe(f.signature(f.snapshot()));
});

it.each([
  ["source addition", "src/shadow.ts", "export const shadow = 1;\n"],
  ["package addition", "src/package.json", '{"type":"commonjs"}'],
  ["nested workspace metadata", "packages/local/.tmp/package.json", '{"type":"commonjs"}'],
  [
    "installed package metadata",
    "packages/local/package.json",
    '{"name":"fixture-package","type":"commonjs"}',
  ],
  ["inherited config", "base.json", '{"compilerOptions":{"target":"ES2022","types":[]}}'],
  ["generator input", "scripts/generator.mts", "export const generator = 2;\n"],
  ["compiler input", "tools/compiler.js", "export const compiler = 2;\n"],
])("retains invalidation after a %s change", async (_label, filename, bytes) => {
  const f = fixture();
  const before = f.snapshot();
  await before.prepare();
  const original = f.signature(before);
  f.write(filename!, bytes!);
  const after = f.snapshot();
  await after.prepare();

  expect(f.signature(after)).not.toBe(original);
  expect(f.signature(after)).toBe(f.signature(f.snapshot()));
});

it("rejects metadata changed during asynchronous preparation", async () => {
  const f = fixture();
  const metadata = path.join(f.root, "package.json");
  const read = fs.promises.readFile.bind(fs.promises);
  const reader = vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
    const bytes = await read(...args);
    if (args[0] === metadata) {
      fs.appendFileSync(metadata, "\n");
    }
    return bytes;
  });
  try {
    await expect(f.snapshot().prepare()).rejects.toThrow("Boundary input changed while reading");
  } finally {
    reader.mockRestore();
  }
});
