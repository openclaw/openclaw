import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ARTIFACT_CACHE_VERSION } from "../../scripts/lib/build-artifact-cache.mts";
import { CompilerInputSnapshot } from "../../scripts/lib/compiler-input-snapshot.mts";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
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

function sealDiagnostic(before: CompilerInputSnapshot, after: CompilerInputSnapshot) {
  let message = "";
  try {
    after.seal("tsconfig.json", ["fixture-compiler"], ["src/index.ts"], before, Date.now());
  } catch (error) {
    // Worker errors cross the process boundary as String(error), without custom fields.
    message = String(error);
  }
  const prefix =
    "Error: Boundary configuration or resolution topology changed during compilation: ";
  expect(message.startsWith(prefix)).toBe(true);
  const suffix = message.slice(prefix.length);
  expect(Buffer.byteLength(suffix)).toBeLessThanOrEqual(4096);
  return { suffix, detail: JSON.parse(suffix) };
}

it.each([
  ['{"compilerOptions":{"target":"invalid"},"include":["src/**/*.ts"]}', "TS6046"],
  ['{"include":"src/**/*.ts"}', "TS5024"],
  ['{"files":"src/index.ts"}', "TS5024"],
  ['{"extends":"./missing.json","include":["src/**/*.ts"]}', "TS5083"],
  ['{"compilerOptions": {', "TS1005"],
])("rejects invalid native compiler configuration %s", (config, diagnostic) => {
  const f = fixture();
  f.write("tsconfig.json", config);
  expect(() => f.signature(f.snapshot())).toThrow(diagnostic);
});

it("seals an unchanged captured config at the compilation clock boundary", () => {
  const f = fixture();
  const stage = path.join(f.root, ".artifacts/native-declarations-fixture");
  const config = path.join(stage, "tsconfig.json");
  f.write(path.relative(f.root, config), '{"extends":"../../tsconfig.json"}');
  const before = f.snapshot();
  const signature = before.signature(config, [], [], stage);
  const startedAt = fs.statSync(config).ctimeMs;
  const after = f.snapshot();
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(after.seal(config, [], [], before, startedAt, stage).signature).toBe(signature);
  }
});

it("does not promote config reads from an earlier seal into precompilation evidence", () => {
  const f = fixture();
  const stage = path.join(f.root, ".artifacts/native-declarations-fixture");
  const config = path.join(stage, "tsconfig.json");
  f.write(path.relative(f.root, config), '{"extends":"../../tsconfig.json"}');
  const before = f.snapshot();
  f.signature(before, stage);
  const startedAt = fs.statSync(config).ctimeMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(() => f.snapshot().seal(config, [], [], before, startedAt, stage)).toThrow(
      `Boundary input changed during compilation: ${config}`,
    );
  }
});

it("keeps the clock fence for source bytes first discovered in compiler membership", () => {
  const f = fixture();
  f.write("src/discovered.ts", "export const discovered = 1;\n");
  const before = f.snapshot();
  f.signature(before);
  const startedAt = fs.statSync(path.join(f.root, "src/discovered.ts")).ctimeMs;
  expect(() =>
    f.snapshot().seal("tsconfig.json", [], ["src/discovered.ts"], before, startedAt),
  ).toThrow("Boundary input changed during compilation: src/discovered.ts");
});

it.each(["ctimeMs", "dev", "ino"] as const)(
  "rejects a captured input whose %s changes while its bytes stay identical",
  (field) => {
    const f = fixture();
    const input = path.join(f.root, "src/index.ts");
    const captured = fs.statSync(input);
    const before = f.snapshot();
    f.signature(before);
    const stat = fs.statSync.bind(fs);
    const reader = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      const result = stat(...args);
      if (args[0] === input && result) {
        Object.defineProperty(result, field, { value: captured[field] + 1 });
      }
      return result;
    });
    try {
      // Isolate identity comparison from the timestamp fence for late reads.
      expect(() =>
        f.snapshot().seal("tsconfig.json", [], ["src/index.ts"], before, captured.ctimeMs + 2),
      ).toThrow("Boundary input changed during compilation: src/index.ts");
    } finally {
      reader.mockRestore();
    }
  },
);

it.each(["added", "removed"] as const)("identifies a %s namespace entry when sealing", (change) => {
  const f = fixture();
  const filename = ".workflow-shell-fixture.mjs";
  if (change === "removed") {
    f.write(filename, "export {};\n");
  }
  const before = f.snapshot();
  f.signature(before);
  if (change === "added") {
    f.write(filename, "export {};\n");
  } else {
    fs.unlinkSync(path.join(f.root, filename));
  }
  // Namespace remains the first rejection even when a later guard also differs.
  f.write("tools/compiler.js", "export const compiler = 2;\n");
  const after = f.snapshot();
  f.signature(after);
  const reader = vi.spyOn(fs, "readFileSync");
  try {
    expect(sealDiagnostic(before, after).detail).toEqual({
      category: "namespace",
      changes: [{ change, path: filename }],
      omitted: 0,
    });
    expect(reader).not.toHaveBeenCalled();
  } finally {
    reader.mockRestore();
  }
});

it("admits exact producer additions while retaining their completed namespace signature", () => {
  const f = fixture();
  const before = f.snapshot();
  const original = f.signature(before);
  const startedAt = Date.now();
  const output = path.join(fs.realpathSync.native(f.root), "runtime-output/chunk.mjs");
  f.write("runtime-output/chunk.mjs", "export const bundled = 1;\n");
  const after = f.snapshot();
  const sealed = after.seal(
    "tsconfig.json",
    ["fixture-compiler"],
    ["src/index.ts"],
    before,
    startedAt,
    undefined,
    new Set([output]),
  );
  expect(sealed.signature).toBe(f.signature(after));
  expect(sealed.signature).not.toBe(original);
});

it.each(["unowned root addition", "consumed output input", "output directory symlink"])(
  "retains the compiler boundary for a %s alongside producer facts",
  (change) => {
    const f = fixture();
    const canonicalRoot = fs.realpathSync.native(f.root);
    if (change === "output directory symlink") {
      fs.symlinkSync(
        path.join(f.root, "src"),
        path.join(f.root, "runtime-output"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const before = f.snapshot();
    f.signature(before);
    const startedAt = Date.now();
    let output = path.join(canonicalRoot, "chunk.mjs");
    if (change === "unowned root addition") {
      f.write("chunk.mjs", "export const bundled = 1;\n");
      f.write("unowned.ts", "export const candidate = 1;\n");
    } else if (change === "consumed output input") {
      output = path.join(canonicalRoot, "src/index.ts");
      f.write("src/index.ts", "export const value = 2;\n");
    } else {
      output = path.join(canonicalRoot, "runtime-output/chunk.mjs");
      f.write("src/chunk.mjs", "export const bundled = 1;\n");
    }
    expect(() =>
      f
        .snapshot()
        .seal(
          "tsconfig.json",
          ["fixture-compiler"],
          ["src/index.ts"],
          before,
          startedAt,
          undefined,
          new Set([output]),
        ),
    ).toThrow(
      change === "consumed output input"
        ? "Boundary input changed during compilation"
        : "Boundary configuration or resolution topology changed during compilation",
    );
  },
);

it.each([
  ["toolchain", "tools/compiler.js", "export const compiler = 2;\n"],
  ["config", "base.json", '{"compilerOptions":{"target":"ES2022","types":[]}}'],
  ["config-bytes", "base.json", '{ "compilerOptions": {"target":"ES2023","types":[]} }\n'],
])(
  "identifies a %s rejection without exposing configuration or tool bytes",
  (category, file, bytes) => {
    const f = fixture();
    const before = f.snapshot();
    f.signature(before);
    f.write(file!, bytes!);
    expect(sealDiagnostic(before, f.snapshot()).detail).toEqual({ category });
  },
);

it.each(["ascii", "unicode", "controls"])(
  "bounds and orders %s namespace diagnostics deterministically",
  (kind) => {
    const f = fixture();
    const before = f.snapshot();
    f.signature(before);
    const segment =
      kind === "ascii"
        ? "x".repeat(80)
        : kind === "unicode"
          ? "😀".repeat(30)
          : "\u0085\u202e\u2066\u2028".repeat(15);
    const filenames = Array.from(
      { length: 20 },
      (_, index) => `added/${String(index).padStart(2, "0")}/${segment}/${segment}.mjs`,
    );
    for (const filename of filenames.toReversed()) {
      f.write(filename, "export {};\n");
    }
    const first = sealDiagnostic(before, f.snapshot());
    const second = sealDiagnostic(before, f.snapshot());
    expect(second.suffix).toBe(first.suffix);
    if (kind === "controls") {
      expect(first.suffix).not.toMatch(/[\u0085\u202e\u2066\u2028]/u);
      expect(first.suffix).toContain("\\u0085\\u202e\\u2066\\u2028");
    }
    const changes = first.detail.changes as { change: string; path: string }[];
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.length).toBeLessThanOrEqual(16);
    expect(first.detail.omitted).toBe(20 - changes.length);
    expect(changes).toEqual(
      filenames.slice(0, changes.length).map((file) => ({
        change: "added",
        path: file.length > 160 ? `${file.slice(0, 157)}...` : file,
      })),
    );
    expect(changes.every(({ path: filename }) => filename.length <= 160)).toBe(true);
  },
);

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
  expect(sealDiagnostic(before, after).detail.category).toBe("namespace");
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
    expect(sealDiagnostic(before, after).detail.category).toBe("namespace");

    fs.rmdirSync(directory);
    const removed = f.snapshot();
    expect(removed.matches(present, "tsconfig.json", ["fixture-compiler"], [])).toBe(false);
    expect(sealDiagnostic(after, removed).detail.category).toBe("namespace");
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
  const diagnostic = sealDiagnostic(before, after);
  expect(diagnostic.detail).toEqual({
    category: "namespace",
    changes: [{ change: "changed", path: "node_modules/external-fixture" }],
    omitted: 0,
  });
  for (const privatePath of [f.root, outside, first, second, indirect, originalLink]) {
    expect(diagnostic.suffix).not.toContain(privatePath);
  }
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
