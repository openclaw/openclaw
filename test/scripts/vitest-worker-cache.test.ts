import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const roots = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = roots.make("vitest-worker-cache-");
  const directory = path.join(root, ".artifacts/vitest-workers/run-cache-0");
  const compilerInputs = ["scripts/lib/fixture-compiler.mts"];
  const write = (name: string, bytes: string) => {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  };
  write("package.json", '{"name":"worker-cache-fixture","type":"module"}\n');
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        allowJs: true,
        noEmit: true,
        types: [],
      },
      include: ["src/**/*"],
    }),
  );
  write("src/entry.ts", 'import { value } from "./value.js"; console.log(value);\n');
  write("src/value.js", 'export const value = "first";\n');
  write("notes/unrelated.ts", 'export const unrelated = "first";\n');
  write(compilerInputs[0]!, 'export const compilerRevision = "first";\n');
  write("node-host-launcher.mjs", 'export const launcher = "fixture";\n');

  const reserve = () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  };
  reserve();
  const cache = async () => {
    const result = await createVitestWorkerCache(root, directory, compilerInputs);
    expect(result, "a reserved local cache slot must be eligible").toBeDefined();
    return result!;
  };
  const prepare = () => {
    const outputs = {
      "probe.js":
        "#!/usr/bin/env node\n" +
        fs.readFileSync(path.join(root, "src/value.js"), "utf8") +
        `console.log(JSON.stringify({value,generation:${JSON.stringify(pathToFileURL(directory).href)}}));\n`,
      "../node-host-launcher.mjs": fs.readFileSync(
        path.join(root, "node-host-launcher.mjs"),
        "utf8",
      ),
      "build-info.json": `${JSON.stringify({
        version: "0.0.0-fixture",
        commit: "a".repeat(40),
        builtAt: "2026-09-19T00:00:00.000Z",
        buildId: "worker-cache-fixture",
      })}\n`,
      "nested/deeper.js": 'export const nested = "fixture";\n',
    };
    for (const [name, bytes] of Object.entries(outputs)) {
      const filename = path.join(directory, "dist", name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, bytes);
    }
    fs.chmodSync(path.join(directory, "dist/probe.js"), 0o755);
    const inputs = Object.fromEntries(
      [
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "src/entry.ts",
        "src/value.js",
        "node-host-launcher.mjs",
      ]
        .map((name) => path.join(root, name))
        .toSorted()
        .map((filename) => [filename, hashVitestWorkerArtifact(fs.readFileSync(filename))]),
    );
    const hashes = Object.fromEntries(
      Object.entries(outputs)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, bytes]) => [name, hashVitestWorkerArtifact(bytes)]),
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
  const seed = async () => {
    const owner = await cache();
    expect(await owner.restore()).toBeUndefined();
    const manifest = prepare();
    manifest.cacheSignature = await owner.seal(manifest);
    await verifyVitestWorkerArtifacts(directory, manifest);
    expect(await retainVitestWorkerArtifacts(root, directory, manifest)).toBe(true);
    return manifest;
  };
  const restore = async () => (await cache()).restore();
  const nextInvocation = () => {
    fs.rmSync(directory, { recursive: true });
    reserve();
  };
  const observe = () => {
    const result = spawnSync(process.execPath, [path.join(directory, "dist/probe.js")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  return {
    root,
    directory,
    compilerInputs,
    write,
    cache,
    prepare,
    seed,
    restore,
    nextInvocation,
    observe,
  };
}

function cachedProbe(root: string, directory: string): string {
  const matches: string[] = [];
  const visit = (parent: string) => {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const filename = path.join(parent, entry.name);
      if (filename === directory) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(filename);
      } else if (entry.isFile() && entry.name === "probe.js") {
        matches.push(filename);
      }
    }
  };
  visit(root);
  expect(matches, "the published generation must have one cached probe").toHaveLength(1);
  return matches[0]!;
}

describe("compiled worker content cache", () => {
  it("propagates namespace rejection evidence without publishing a cache signature", async () => {
    const f = fixture();
    const owner = await f.cache();
    expect(await owner.restore()).toBeUndefined();
    const manifest = f.prepare();
    f.write(".workflow-shell-fixture.mjs", "export {};\n");

    await expect(owner.seal(manifest)).rejects.toThrow(
      'Boundary configuration or resolution topology changed during compilation: {"category":"namespace","changes":[{"change":"added","path":".workflow-shell-fixture.mjs"}],"omitted":0}',
    );
    expect(manifest.cacheSignature).toBeUndefined();
    expect(await retainVitestWorkerArtifacts(f.root, f.directory, manifest)).toBe(false);
    expect(
      fs.existsSync(path.join(f.root, ".artifacts/vitest-worker-cache/run-cache-0/stamp.json")),
    ).toBe(false);
  });

  it.each([
    "NODE_PATH",
    "NAPI_RS_NATIVE_LIBRARY_PATH",
    "NAPI_RS_WASI_FLAVOR",
    "NAPI_RS_FORCE_WASI",
  ])("honors the explicitly selected compiler through %s", (name) => {
    expect(useVitestWorkerCache({ [name]: "override" })).toBe(false);
    expect(
      useVitestWorkerCache({ CI: "1", OPENCLAW_VITEST_WORKER_CACHE: "1", [name]: "override" }),
    ).toBe(false);
  });
  it("requires an explicit CI cache opt-in without overriding custom loaders", () => {
    for (const ciEnv of [{ CI: "1" }, { GITHUB_ACTIONS: "true" }]) {
      expect(useVitestWorkerCache(ciEnv)).toBe(false);
      expect(useVitestWorkerCache({ ...ciEnv, OPENCLAW_VITEST_WORKER_CACHE: "0" })).toBe(false);
      const enabled = { ...ciEnv, OPENCLAW_VITEST_WORKER_CACHE: "1" };
      expect(useVitestWorkerCache(enabled)).toBe(!process.versions.bun);
      expect(useVitestWorkerCache({ ...enabled, NODE_OPTIONS: "--import=./loader.mjs" })).toBe(
        false,
      );
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
    const cached = path.join(f.root, ".artifacts/vitest-worker-cache/run-cache-0");
    expect(fs.existsSync(path.join(cached, "stamp.json"))).toBe(false);
    await verifyVitestWorkerArtifacts(f.directory, manifest);
    expect(await retainVitestWorkerArtifacts(f.root, f.directory, manifest)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(cached).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(cached, "outputs")).mode & 0o777).toBe(0o700);
    }
    expect(fs.existsSync(path.join(f.directory, "dist"))).toBe(false);
    expect(fs.existsSync(path.join(f.directory, "package.json"))).toBe(true);
    f.nextInvocation();

    const restored = await f.restore();
    expect(restored).toBeDefined();
    expect(restored!.outputs).toEqual(manifest.outputs);
    expect(fs.readFileSync(path.join(f.directory, "dist/nested/deeper.js"), "utf8")).toBe(
      'export const nested = "fixture";\n',
    );
    expect(fs.existsSync(path.join(cached, "stamp.json"))).toBe(false);
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

  it("reuses content after timestamp-only changes and unrelated source edits", async () => {
    const f = fixture();
    const manifest = await f.seed();
    f.nextInvocation();
    fs.utimesSync(path.join(f.root, "src/value.js"), new Date(1000), new Date(1000));
    f.write("notes/unrelated.ts", 'export const unrelated = "second";\n');

    expect((await f.restore())?.outputs).toEqual(manifest.outputs);
    expect(f.observe().value).toBe("first");
  });

  it("observes resolution changes made while checking cached output bytes", async () => {
    const f = fixture();
    await f.seed();
    const probe = cachedProbe(f.root, f.directory);
    f.nextInvocation();
    const read = fs.promises.readFile.bind(fs.promises);
    let changed = false;
    const reader = vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
      const bytes = await read(...args);
      if (args[0] === probe && !changed) {
        changed = true;
        f.write("src/package.json", '{"type":"commonjs"}');
      }
      return bytes;
    });
    try {
      expect(await f.restore()).toBeUndefined();
      expect(changed).toBe(true);
      expect(fs.existsSync(path.join(f.directory, "dist"))).toBe(false);
    } finally {
      reader.mockRestore();
    }
  });

  it("invalidates edited source and then restores the newly compiled worker behavior", async () => {
    const f = fixture();
    await f.seed();
    f.nextInvocation();
    const original = fs.statSync(path.join(f.root, "src/value.js"));
    f.write("src/value.js", 'export const value = "other";\n');
    fs.utimesSync(path.join(f.root, "src/value.js"), original.atime, original.mtime);

    const cache = await f.cache();
    expect(await cache.restore()).toBeUndefined();
    expect(fs.existsSync(path.join(f.directory, "dist/probe.js"))).toBe(false);
    const changed = f.prepare();
    changed.cacheSignature = await cache.seal(changed);
    await verifyVitestWorkerArtifacts(f.directory, changed);
    expect(await retainVitestWorkerArtifacts(f.root, f.directory, changed)).toBe(true);
    f.nextInvocation();

    expect(await f.restore()).toBeDefined();
    expect(f.observe().value).toBe("other");
  });

  it.each([
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
    expect(fs.existsSync(path.join(f.directory, "dist/probe.js"))).toBe(false);
  });

  it.each(["corrupt", "missing"] as const)("rejects a %s cached output", async (damage) => {
    const f = fixture();
    await f.seed();
    const seed = cachedProbe(f.root, f.directory);
    if (damage === "corrupt") {
      fs.appendFileSync(seed, "\nthrow new Error('corrupted seed');\n");
    } else {
      fs.unlinkSync(seed);
    }
    f.nextInvocation();

    expect(await f.restore()).toBeUndefined();
    expect(fs.existsSync(path.join(f.directory, "dist/probe.js"))).toBe(false);
  });

  it.each(["dist/build-info.json", "dist/probe.js"])(
    "rejects an inventory missing %s even when remaining hashes match",
    async (missing) => {
      const f = fixture();
      await f.seed();
      const stamp = path.join(f.root, ".artifacts/vitest-worker-cache/run-cache-0/stamp.json");
      const record = JSON.parse(fs.readFileSync(stamp, "utf8"));
      delete record.outputs[missing];
      fs.writeFileSync(stamp, JSON.stringify(record));
      f.nextInvocation();

      expect(await f.restore()).toBeUndefined();
      expect(fs.existsSync(path.join(f.directory, "dist/probe.js"))).toBe(false);
    },
  );

  it("rejects inventory entries outside the compiler manifest", async () => {
    const f = fixture();
    await f.seed();
    const cached = path.join(f.root, ".artifacts/vitest-worker-cache/run-cache-0");
    const stamp = path.join(cached, "stamp.json");
    const record = JSON.parse(fs.readFileSync(stamp, "utf8"));
    const owner = ".vitest-resource-owner/owner";
    const bytes = "unrelated ownership receipt";
    fs.mkdirSync(path.dirname(path.join(cached, "outputs", owner)));
    fs.writeFileSync(path.join(cached, "outputs", owner), bytes);
    record.outputs[owner] = hashVitestWorkerArtifact(bytes);
    fs.writeFileSync(stamp, JSON.stringify(record));
    f.nextInvocation();

    expect(await f.restore()).toBeUndefined();
    expect(fs.existsSync(path.join(f.directory, ".vitest-resource-owner"))).toBe(false);
  });

  it("rejects a copied checkout whose absolute emitted generation path changed", async () => {
    const f = fixture();
    await f.seed();
    f.nextInvocation();
    const relocated = roots.make("vitest-worker-cache-relocated-");
    fs.cpSync(f.root, relocated, { recursive: true });
    const directory = path.join(relocated, path.relative(f.root, f.directory));
    const cache = await createVitestWorkerCache(relocated, directory, f.compilerInputs);

    expect(cache).toBeDefined();
    expect(await cache!.restore()).toBeUndefined();
    expect(fs.existsSync(path.join(directory, "dist/probe.js"))).toBe(false);
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
      expect(
        fs.existsSync(path.join(f.root, ".artifacts/vitest-worker-cache/run-cache-0/stamp.json")),
      ).toBe(false);
    } finally {
      release();
      resources.assertReleased();
    }
    await verifyVitestWorkerArtifacts(f.directory, manifest);
    expect(await retainVitestWorkerArtifacts(f.root, f.directory, manifest)).toBe(true);
    expect(fs.existsSync(path.join(f.directory, ".vitest-resource-owner"))).toBe(true);
    f.nextInvocation();

    expect(await f.restore()).toBeDefined();
    expect(fs.existsSync(path.join(f.directory, ".vitest-resource-owner"))).toBe(false);
    expect(f.observe().value).toBe("first");
  });

  it.each(["file", "directory", "symlink"] as const)(
    "discards retention with an unexpected nested %s",
    async (kind) => {
      const f = fixture();
      const cache = await f.cache();
      expect(await cache.restore()).toBeUndefined();
      const manifest = f.prepare();
      manifest.cacheSignature = await cache.seal(manifest);
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
      await verifyVitestWorkerArtifacts(f.directory, manifest);

      expect(await retainVitestWorkerArtifacts(f.root, f.directory, manifest)).toBe(false);
      expect(fs.existsSync(path.join(f.directory, "dist/nested/deeper.js"))).toBe(true);
      expect(
        fs.existsSync(path.join(f.root, ".artifacts/vitest-worker-cache/run-cache-0/stamp.json")),
      ).toBe(false);
    },
  );

  it("rejects unrecorded nested files added to a retained seed", async () => {
    const f = fixture();
    await f.seed();
    const outputRoot = path.join(f.root, ".artifacts/vitest-worker-cache/run-cache-0/outputs");
    fs.writeFileSync(path.join(outputRoot, "dist/nested/runtime.sqlite"), "runtime state");
    f.nextInvocation();

    expect(await f.restore()).toBeUndefined();
    expect(fs.existsSync(path.join(f.directory, "dist"))).toBe(false);
  });

  it("retains captured manifest facts instead of runtime-written metadata", async () => {
    const f = fixture();
    const cache = await f.cache();
    expect(await cache.restore()).toBeUndefined();
    const manifest = f.prepare();
    manifest.cacheSignature = await cache.seal(manifest);
    fs.writeFileSync(path.join(f.directory, "manifest.json"), "{}");
    await verifyVitestWorkerArtifacts(f.directory, manifest);

    expect(await retainVitestWorkerArtifacts(f.root, f.directory, manifest)).toBe(true);
    f.nextInvocation();
    const restored = await f.restore();
    expect(restored?.identity).toBe(manifest.identity);
    expect(restored?.cacheSignature).toBe(manifest.cacheSignature);
    expect(f.observe().value).toBe("first");
  });
});
