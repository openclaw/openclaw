import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { readNativeTypeScriptConfig } from "../../scripts/lib/native-typescript-config.mts";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import {
  hashVitestWorkerArtifact,
  verifyVitestWorkerArtifacts,
  type VitestWorkerManifest,
} from "../../scripts/lib/vitest-worker-artifacts.mts";
import { useVitestWorkerCache } from "../../scripts/lib/vitest-worker-cache-policy.mts";
import {
  createVitestWorkerCache,
  retainVitestWorkerArtifacts,
} from "../../scripts/lib/vitest-worker-cache.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeFixture } from "./vitest-worker-artifacts.test-support.js";

vi.mock("../../scripts/lib/native-typescript-config.mts", { spy: true });
vi.mock("../../scripts/lib/native-typescript.mts", { spy: true });

const roots = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = roots.make("vitest-worker-cache-");
  const directory = path.join(root, ".artifacts/vitest-workers/run-cache-0");
  const cached = path.join(root, ".artifacts/vitest-worker-cache/run-cache-0");
  const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
  const write = (name: string, bytes: string) => writeFixture(root, name, bytes);
  const sources = {
    "package.json": '{"name":"worker-cache-fixture","type":"module"}\n',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "tsconfig.json":
      '{"extends":"./tsconfig.base.json","compilerOptions":{"target":"ES2023","module":"NodeNext","moduleResolution":"NodeNext","allowJs":true,"noEmit":true,"types":[]},"include":["src/**/*"]}',
    "tsconfig.base.json": '{"compilerOptions":{"strict":true}}\n',
    "src/entry.ts": 'import { value } from "./value.js"; console.log(value);\n',
    "src/value.js": 'export const value = "first";\n',
    "scripts/lib/fixture-compiler.mts": 'export const compilerRevision = "first";\n',
    "node-host-launcher.mjs": 'export const launcher = "fixture";\n',
    "cli-invocation.mjs": 'export const invocation = "fixture";\n',
  };
  for (const [name, bytes] of Object.entries(sources)) {
    write(name, bytes);
  }
  write("notes/unrelated.ts", 'export const unrelated = "first";\n');

  const reserve = () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  };
  reserve();
  const cache = async () => {
    const result = await createVitestWorkerCache(root, directory);
    expect(result, "a reserved local cache slot must be eligible").toBeDefined();
    return result!;
  };
  const prepare = () => {
    const { configFiles } = readNativeTypeScriptConfig({
      cwd: root,
      configFileName: "tsconfig.json",
    });
    const outputs = {
      "probe.js":
        "#!/usr/bin/env node\n" +
        read("src/value.js") +
        `console.log(JSON.stringify({value,generation:${JSON.stringify(pathToFileURL(directory).href)}}));\n`,
      "../node-host-launcher.mjs": read("node-host-launcher.mjs"),
      "../cli-invocation.mjs": read("cli-invocation.mjs"),
      "build-info.json": "{}\n",
      "nested/deeper.js": 'export const nested = "fixture";\n',
    };
    const hashes: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(outputs).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const filename = path.join(directory, "dist", name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, bytes);
      hashes[name] = hashVitestWorkerArtifact(bytes);
    }
    fs.chmodSync(path.join(directory, "dist/probe.js"), 0o755);
    const inputs = Object.fromEntries(
      [...Object.keys(sources), ...configFiles]
        .map((name) => path.resolve(root, name))
        .toSorted()
        .map((filename) => [filename, hashVitestWorkerArtifact(fs.readFileSync(filename))]),
    );
    const manifest: VitestWorkerManifest = {
      inputs,
      outputs: hashes,
      identity: hashVitestWorkerArtifact(JSON.stringify([inputs, hashes])),
      durationMs: 1,
    };
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    return manifest;
  };
  return {
    root,
    directory,
    cached,
    write,
    cache,
    prepare,
    async compile() {
      const owner = await cache();
      expect(await owner.restore()).toBeUndefined();
      const manifest = prepare();
      manifest.cacheSignature = await owner.seal(manifest);
      return manifest;
    },
    async retain(manifest: VitestWorkerManifest, expected = true) {
      await verifyVitestWorkerArtifacts(directory, manifest);
      expect(await retainVitestWorkerArtifacts(root, directory, manifest)).toBe(expected);
    },
    async seed(): Promise<VitestWorkerManifest> {
      const manifest = await this.compile();
      await this.retain(manifest);
      return manifest;
    },
    restore: async () => (await cache()).restore(),
    nextInvocation() {
      fs.rmSync(directory, { recursive: true });
      reserve();
    },
    observe() {
      const result = spawnSync(process.execPath, [path.join(directory, "dist/probe.js")], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    },
    expectAbsent: (name: string) => expect(fs.existsSync(path.join(directory, name))).toBe(false),
    expectUnpublished: () => expect(fs.existsSync(path.join(cached, "stamp.json"))).toBe(false),
  };
}

it.each(["NODE_PATH", "NAPI_RS_NATIVE_LIBRARY_PATH", "NAPI_RS_WASI_FLAVOR", "NAPI_RS_FORCE_WASI"])(
  "honors the explicitly selected compiler through %s",
  (name) => {
    expect(useVitestWorkerCache({ [name]: "override" })).toBe(false);
    expect(
      useVitestWorkerCache({ CI: "1", OPENCLAW_VITEST_WORKER_CACHE: "1", [name]: "override" }),
    ).toBe(false);
  },
);
it("requires an explicit CI cache opt-in without overriding custom loaders", () => {
  for (const ciEnv of [{ CI: "1" }, { GITHUB_ACTIONS: "true" }]) {
    expect(useVitestWorkerCache(ciEnv)).toBe(false);
    expect(useVitestWorkerCache({ ...ciEnv, OPENCLAW_VITEST_WORKER_CACHE: "0" })).toBe(false);
    const enabled = { ...ciEnv, OPENCLAW_VITEST_WORKER_CACHE: "1" };
    expect(useVitestWorkerCache(enabled)).toBe(!process.versions.bun);
    expect(useVitestWorkerCache({ ...enabled, NODE_OPTIONS: "--import=./loader.mjs" })).toBe(false);
    expect(useVitestWorkerCache(enabled, ["--require", "./loader.cjs"])).toBe(false);
  }
});
it("restores identical executable bytes into the same reserved generation path", async () => {
  const f = fixture();
  const owner = await f.cache();
  expect(await owner.restore()).toBeUndefined();
  const manifest = f.prepare();
  expect(f.observe()).toEqual({
    value: "first",
    generation: pathToFileURL(f.directory).href,
  });
  expect(await retainVitestWorkerArtifacts(f.root, f.directory, manifest)).toBe(false);
  manifest.cacheSignature = await owner.seal(manifest);
  const { cached } = f;
  f.expectUnpublished();
  await f.retain(manifest);
  if (process.platform !== "win32") {
    expect(fs.statSync(cached).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(cached, "outputs")).mode & 0o777).toBe(0o700);
  }
  f.expectAbsent("dist");
  expect(fs.existsSync(path.join(f.directory, "package.json"))).toBe(true);
  f.nextInvocation();

  const restored = await f.restore();
  expect(restored).toBeDefined();
  expect(restored!.outputs).toEqual(manifest.outputs);
  expect(fs.readFileSync(path.join(f.directory, "dist/nested/deeper.js"), "utf8")).toBe(
    'export const nested = "fixture";\n',
  );
  f.expectUnpublished();
  expect(fs.existsSync(path.join(cached, "outputs"))).toBe(false);
  await verifyVitestWorkerArtifacts(f.directory, restored!);
  if (process.platform !== "win32") {
    const direct = spawnSync(path.join(f.directory, "dist/probe.js"), {
      cwd: f.root,
      encoding: "utf8",
    });
    expect(direct.status, String(direct.error ?? direct.stderr)).toBe(0);
    expect(JSON.parse(direct.stdout).value).toBe("first");
  }
  expect(f.observe()).toEqual({
    value: "first",
    generation: pathToFileURL(f.directory).href,
  });
});

it("observes resolution changes made while checking cached output bytes", async () => {
  const f = fixture();
  await f.seed();
  const probe = path.join(f.cached, "outputs/dist/probe.js");
  f.nextInvocation();
  const read = fs.readFile.bind(fs);
  let changed = false;
  const reader = vi.spyOn(fs, "readFile").mockImplementation((...args) => {
    if (args[0] !== probe) {
      return read(...args);
    }
    const [filename, callback] = args;
    read(filename, (error, bytes) => {
      if (!error && !changed) {
        changed = true;
        f.write("src/package.json", '{"type":"commonjs"}');
      }
      callback(error, bytes);
    });
  });
  try {
    expect(await f.restore()).toBeUndefined();
    expect(changed).toBe(true);
    expect(fs.existsSync(path.join(f.directory, "dist"))).toBe(false);
  } finally {
    reader.mockRestore();
  }
});

it("opens native projects only on misses and recompiles changed transitive inputs", async () => {
  const f = fixture();
  const invoke = async () => {
    vi.mocked(createNativeTypeScriptProject).mockClear();
    vi.mocked(readNativeTypeScriptConfig).mockClear();
    const owner = await f.cache();
    let manifest = await owner.restore();
    if (!manifest) {
      collectRuntimeImportClosure(f.root, ["src/entry.ts"]);
      manifest = f.prepare();
      manifest.cacheSignature = await owner.seal(manifest);
    }
    const value = f.observe().value;
    await f.retain(manifest);
    f.nextInvocation();
    return {
      value,
      projects: vi.mocked(createNativeTypeScriptProject).mock.calls.length,
      configs: vi.mocked(readNativeTypeScriptConfig).mock.calls.length,
    };
  };

  expect(await invoke()).toMatchObject({ value: "first", projects: 1 });
  expect(await invoke()).toEqual({ value: "first", projects: 0, configs: 0 });

  const original = fs.statSync(path.join(f.root, "src/value.js"));
  f.write("src/value.js", 'export const value = "other";\n');
  fs.utimesSync(path.join(f.root, "src/value.js"), original.atime, original.mtime);
  expect(await invoke()).toMatchObject({ value: "other", projects: 1 });
});

it.each([
  ["extended config", "tsconfig.base.json", '{"compilerOptions":{"strict":false}}\n'],
  ["resolution candidate", "src/value.ts", 'export const value = "shadow";\n'],
  [
    "package resolution metadata",
    "package.json",
    '{"name":"worker-cache-fixture","type":"module","imports":{"#value":"./src/value.js"}}\n',
  ],
  [
    "compiler source",
    "scripts/lib/fixture-compiler.mts",
    'export const compilerRevision = "second";\n',
  ],
])("invalidates when %s changes", async (_label, filename, contents) => {
  const f = fixture();
  await f.seed();
  f.nextInvocation();
  f.write(filename!, contents!);

  expect(await f.restore()).toBeUndefined();
  f.expectAbsent("dist/probe.js");
});

it.each([
  "corrupt",
  "missing",
  "incomplete inventory",
  "foreign inventory",
  "unrecorded file",
  "relocated",
])("rejects a retained generation with %s", async (damage) => {
  const f = fixture();
  await f.seed();
  const { cached } = f;
  if (damage === "corrupt" || damage === "missing") {
    const probe = path.join(f.cached, "outputs/dist/probe.js");
    if (damage === "corrupt") {
      fs.appendFileSync(probe, "\nthrow new Error('corrupted seed');\n");
    } else {
      fs.unlinkSync(probe);
    }
  } else if (damage === "incomplete inventory" || damage === "foreign inventory") {
    const stamp = path.join(cached, "stamp.json");
    const record = JSON.parse(fs.readFileSync(stamp, "utf8"));
    if (damage === "incomplete inventory") {
      delete record.outputs["dist/probe.js"];
    } else {
      const owner = ".vitest-resource-owner/owner";
      const bytes = "unrelated ownership receipt";
      fs.mkdirSync(path.dirname(path.join(cached, "outputs", owner)));
      fs.writeFileSync(path.join(cached, "outputs", owner), bytes);
      record.outputs[owner] = hashVitestWorkerArtifact(bytes);
    }
    fs.writeFileSync(stamp, JSON.stringify(record));
  } else if (damage === "unrecorded file") {
    fs.writeFileSync(path.join(cached, "outputs/dist/nested/runtime.sqlite"), "runtime state");
  }
  f.nextInvocation();
  const root = damage === "relocated" ? roots.make("vitest-worker-cache-relocated-") : f.root;
  if (damage === "relocated") {
    fs.cpSync(f.root, root, { recursive: true });
  }
  const directory = path.join(root, path.relative(f.root, f.directory));
  const cache = await createVitestWorkerCache(root, directory);
  expect(cache).toBeDefined();
  expect(await cache!.restore()).toBeUndefined();
  const absent =
    damage === "foreign inventory"
      ? ".vitest-resource-owner"
      : damage === "unrecorded file"
        ? "dist"
        : "dist/probe.js";
  expect(fs.existsSync(path.join(directory, absent))).toBe(false);
});

it("restores only compiler outputs, leaving resource claims with their invocation", async () => {
  const f = fixture();
  const cache = await f.cache();
  expect(await cache.restore()).toBeUndefined();
  const manifest = f.prepare();
  const resources = createVitestResourceOwner(f.directory);
  const release = resources.claim();
  try {
    manifest.cacheSignature = await cache.seal(manifest);
    expect(f.observe().value).toBe("first");
    f.expectUnpublished();
  } finally {
    release();
    resources.assertReleased();
  }
  await f.retain(manifest);
  expect(fs.existsSync(path.join(f.directory, ".vitest-resource-owner"))).toBe(true);
  f.nextInvocation();

  expect(await f.restore()).toBeDefined();
  f.expectAbsent(".vitest-resource-owner");
  expect(f.observe().value).toBe("first");
});

it.each(["file", "directory", "symlink"] as const)(
  "discards retention with an unexpected nested %s",
  async (kind) => {
    const f = fixture();
    const manifest = await f.compile();
    const unexpected = path.join(f.directory, "dist/nested/unexpected");
    if (kind === "file") {
      fs.writeFileSync(unexpected, "runtime state");
    } else if (kind === "directory") {
      fs.mkdirSync(unexpected);
    } else {
      fs.symlinkSync(
        path.join(f.directory, "dist/nested"),
        unexpected,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    await f.retain(manifest, false);
    expect(fs.existsSync(path.join(f.directory, "dist/nested/deeper.js"))).toBe(true);
    f.expectUnpublished();
  },
);

it.each(["timestamps and unrelated source", "runtime-written metadata"])(
  "restores captured compiler facts despite changes to %s",
  async (change) => {
    const f = fixture();
    const manifest = await f.compile();
    if (change === "runtime-written metadata") {
      fs.writeFileSync(path.join(f.directory, "manifest.json"), "{}");
    }
    await f.retain(manifest);
    f.nextInvocation();
    if (change === "timestamps and unrelated source") {
      fs.utimesSync(path.join(f.root, "src/value.js"), new Date(1000), new Date(1000));
      f.write("notes/unrelated.ts", 'export const unrelated = "second";\n');
    }
    const restored = await f.restore();
    expect(restored?.outputs).toEqual(manifest.outputs);
    expect(restored?.identity).toBe(manifest.identity);
    expect(restored?.cacheSignature).toBe(manifest.cacheSignature);
    expect(f.observe().value).toBe("first");
  },
);
