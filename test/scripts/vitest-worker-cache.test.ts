import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
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
import type { VitestWorkerPreset } from "../../scripts/lib/vitest-worker-descriptor.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeWorkerFixtureManifest } from "./fixtures/vitest-worker-compiler.mjs";
import { writeFixture } from "./vitest-worker-artifacts.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

function fixture(slot = "run-cache-0", root = roots.make("vitest-worker-cache-")) {
  const directory = path.join(root, ".artifacts/vitest-workers", slot);
  const cached = path.join(root, ".artifacts/vitest-worker-cache", slot);
  const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
  const write = (name: string, bytes: string) => writeFixture(root, name, bytes);
  const sources = {
    "package.json": '{"name":"worker-cache-fixture","type":"module"}\n',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "src/value.js": 'export const value = "first";\n',
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
  const cache = async (preset?: VitestWorkerPreset) => {
    const result = await createVitestWorkerCache(root, directory, preset);
    expect(result, "a reserved local cache slot must be eligible").toBeDefined();
    return result!;
  };
  const prepare = () => {
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
    const inputs = Object.fromEntries(
      Object.keys(sources).map((name) => {
        const filename = path.resolve(root, name);
        return [filename, fs.readFileSync(filename)];
      }),
    );
    const manifest: VitestWorkerManifest = writeWorkerFixtureManifest(directory, inputs, outputs);
    fs.chmodSync(path.join(directory, "dist/probe.js"), 0o755);
    return manifest;
  };
  return {
    root,
    directory,
    cached,
    write,
    cache,
    prepare,
    async compile(preset?: VitestWorkerPreset) {
      const owner = await cache(preset);
      expect(await owner.restore()).toBeUndefined();
      const manifest = prepare();
      manifest.cacheSignature = await owner.seal(manifest);
      return manifest;
    },
    async retain(manifest: VitestWorkerManifest, expected = true) {
      await verifyVitestWorkerArtifacts(directory, manifest);
      expect(await retainVitestWorkerArtifacts(root, directory, manifest)).toBe(expected);
    },
    async seed(preset?: VitestWorkerPreset): Promise<VitestWorkerManifest> {
      const manifest = await this.compile(preset);
      await this.retain(manifest);
      return manifest;
    },
    restore: async (preset?: VitestWorkerPreset) => (await cache(preset)).restore(),
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
  const expected = { value: "first", generation: pathToFileURL(f.directory).href };
  expect(f.observe()).toEqual(expected);
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
  expect(f.observe()).toEqual(expected);
});

it("leaves incompatible preset generations available for their original borrower", async () => {
  for (const preset of ["full", "runtime"] as const) {
    const f = fixture();
    await f.seed(preset);
    f.nextInvocation();
    expect(await f.restore(preset === "full" ? "runtime" : "full")).toBeUndefined();
    f.expectAbsent("dist");

    const restored = await f.restore(preset === "full" ? undefined : preset);
    expect(restored).toBeDefined();
    expect(f.observe()).toEqual({ value: "first", generation: pathToFileURL(f.directory).href });
  }
});

it("retains full and runtime generations independently at their original executable paths", async () => {
  const full = fixture();
  await full.seed();
  full.nextInvocation();
  const runtime = fixture("run-cache-runtime-0", full.root);
  await runtime.seed("runtime");
  runtime.nextInvocation();

  for (const [f, preset] of [
    [full, "full"],
    [runtime, "runtime"],
  ] as const) {
    expect(await f.restore(preset)).toBeDefined();
    expect(f.observe()).toEqual({ value: "first", generation: pathToFileURL(f.directory).href });
  }
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
    f.expectAbsent("dist");
  } finally {
    reader.mockRestore();
  }
});

it("invalidates changed input bytes even when the timestamp is unchanged", async () => {
  const f = fixture();
  await f.seed();
  f.nextInvocation();
  const original = fs.statSync(path.join(f.root, "src/value.js"));
  f.write("src/value.js", 'export const value = "other";\n');
  fs.utimesSync(path.join(f.root, "src/value.js"), original.atime, original.mtime);
  expect(await f.restore()).toBeUndefined();
  f.expectAbsent("dist/probe.js");
});

it("invalidates when a new resolution candidate appears", async () => {
  const f = fixture();
  await f.seed();
  f.nextInvocation();
  f.write("src/value.ts", 'export const value = "shadow";\n');

  expect(await f.restore()).toBeUndefined();
  f.expectAbsent("dist/probe.js");
});

it.each(["corrupt", "incomplete inventory", "foreign inventory", "unrecorded file", "relocated"])(
  "rejects a retained generation with %s",
  async (damage) => {
    const f = fixture();
    await f.seed();
    const { cached } = f;
    if (damage === "corrupt") {
      fs.appendFileSync(
        path.join(cached, "outputs/dist/probe.js"),
        "\nthrow new Error('corrupted seed');\n",
      );
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
  },
);

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
