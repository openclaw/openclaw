import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StandaloneBuildInfo } from "../../cli-invocation.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { gitRuntimeStagingPath } from "../infra/update-runtime-staging.js";
import { fingerprintPluginRuntimeArtifact } from "./plugin-runtime-artifact-identity.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

function write(filename: string, content: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function createPluginFixture() {
  const rootDir = temp.make("openclaw-plugin-artifact-");
  const source = path.join(rootDir, "dist", "index.js");
  write(source, 'export { run } from "./runtime.js";\n');
  write(path.join(rootDir, "dist", "runtime.js"), "export const run = () => 1;\n");
  write(path.join(rootDir, "package.json"), '{"name":"fixture"}\n');
  return { pluginId: "fixture", origin: "global" as const, rootDir, source };
}

function interceptReads(
  operation: (fd: number, buffer: NodeJS.ArrayBufferView, options: fs.ReadOptions) => number,
): void {
  vi.spyOn(fs, "readSync").mockImplementation(
    (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offsetOrOptions: number | fs.ReadOptions = {},
      length?: number,
      position?: fs.ReadPosition | null,
    ) =>
      operation(
        fd,
        buffer,
        typeof offsetOrOptions === "number"
          ? { offset: offsetOrOptions, length, position }
          : offsetOrOptions,
      ),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fingerprintPluginRuntimeArtifact", () => {
  it("binds embedded code to its image build and retained sidecar content", () => {
    const record = { ...createPluginFixture(), origin: "bundled" as const };
    fs.rmSync(path.join(record.rootDir, "dist"), { recursive: true });
    vi.stubGlobal(
      "__openclawStandaloneIsEmbeddedModule",
      (source: string) => source === record.source,
    );
    const build = {
      mode: "aot",
      openclaw: { version: "2026.10.25" },
      bun: { version: "1.3.0" },
      build: {
        id: "image-one",
        flavor: "standard",
        pluginSetSha256: "a".repeat(64),
        moduleGraphSha256: "b".repeat(64),
      },
    } satisfies StandaloneBuildInfo;
    vi.stubGlobal("__openclawStandaloneBuildInfo", build);
    const first = fingerprintPluginRuntimeArtifact(record);
    expect(fingerprintPluginRuntimeArtifact(record)).toBe(first);

    for (const changed of [
      { ...build, build: { ...build.build, id: "image-two" } },
      { ...build, build: { ...build.build, flavor: "support" } },
      { ...build, mode: "jit" },
    ]) {
      vi.stubGlobal("__openclawStandaloneBuildInfo", changed);
      expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(first);
    }

    vi.stubGlobal("__openclawStandaloneBuildInfo", build);
    write(path.join(record.rootDir, "package.json"), '{"name":"fixture","revision":2}\n');
    expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(first);
  });

  it.each(["bundled", "global"] as const)(
    "rejects a missing %s entry without bundled image membership",
    (origin) => {
      const record = { ...createPluginFixture(), origin };
      fs.rmSync(record.source);
      vi.stubGlobal("__openclawStandaloneIsEmbeddedModule", () => origin === "global");
      expect(() => fingerprintPluginRuntimeArtifact(record)).toThrow(
        "plugin runtime entry is unavailable: fixture",
      );
    },
  );

  it("rejects an embedded entry without an image build identity", () => {
    const record = { ...createPluginFixture(), origin: "bundled" as const };
    fs.rmSync(record.source);
    vi.stubGlobal(
      "__openclawStandaloneIsEmbeddedModule",
      (source: string) => source === record.source,
    );
    vi.stubGlobal("__openclawStandaloneBuildInfo", {
      mode: "aot",
      openclaw: { version: "2026.10.25" },
      bun: { version: "1.3.0" },
    });
    expect(() => fingerprintPluginRuntimeArtifact(record)).toThrow(
      "plugin runtime image build is unavailable: fixture",
    );
  });

  it("keeps the same fingerprint when descriptor reads return short chunks", () => {
    const record = createPluginFixture();
    const expected = fingerprintPluginRuntimeArtifact(record);
    const read = fs.readSync;
    interceptReads((fd, buffer, options) =>
      read(fd, buffer, {
        ...options,
        length: Math.min(options.length ?? buffer.byteLength - (options.offset ?? 0), 3),
      }),
    );

    expect(fingerprintPluginRuntimeArtifact(record)).toBe(expected);
  });

  it.each(["shrink", "grow", "edit"] as const)(
    "rejects a %s during hashing without exceeding the pinned read budget or leaking the descriptor",
    (change) => {
      const fixture = createPluginFixture();
      const identity = fs.statSync(fixture.source);
      const read = fs.readSync;
      const descriptors = new Set<number>();
      let bytesRead = 0;
      interceptReads((fd, buffer, options) => {
        const stat = fs.fstatSync(fd);
        if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
          return read(fd, buffer, options);
        }
        if (descriptors.size === 0) {
          descriptors.add(fd);
          const size = change === "shrink" ? 0 : identity.size + (change === "grow" ? 17 : 0);
          fs.writeFileSync(fixture.source, Buffer.alloc(size, 0x78));
          fs.utimesSync(fixture.source, new Date(0), new Date(1));
        }
        const count = read(fd, buffer, options);
        bytesRead += count;
        return count;
      });

      expect(() => fingerprintPluginRuntimeArtifact(fixture)).toThrow(
        "plugin runtime artifact file changed while reading: dist/index.js",
      );
      expect(bytesRead).toBeLessThanOrEqual(identity.size + 1);
      expect(descriptors.size).toBe(1);
      for (const fd of descriptors) {
        expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      }
    },
  );

  it("is stable for unchanged files and changes with plugin-owned imported code", () => {
    const record = createPluginFixture();
    const first = fingerprintPluginRuntimeArtifact(record);
    expect(fingerprintPluginRuntimeArtifact(record)).toBe(first);

    write(path.join(record.rootDir, "dist", "runtime.js"), "export const run = () => 2;\n");
    expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(first);
  });

  it.each(["node_modules", "transaction"])(
    "keeps %s outside the plugin-owned artifact identity",
    (kind) => {
      const record = createPluginFixture();
      const modules = path.join(record.rootDir, "node_modules");
      const root = kind === "transaction" ? gitRuntimeStagingPath(modules) : modules;
      const dependency = path.join(root, "dependency", "index.js");
      const first = fingerprintPluginRuntimeArtifact(record);
      write(dependency, "export const value = 1;\n");
      expect(fingerprintPluginRuntimeArtifact(record)).toBe(first);

      write(dependency, "export const value = 2;\n");
      expect(fingerprintPluginRuntimeArtifact(record)).toBe(first);
      fs.rmSync(root, { recursive: true });
      expect(fingerprintPluginRuntimeArtifact(record)).toBe(first);
    },
  );

  it("hashes canonical dist content when the registry points at dist-runtime", () => {
    const packageRoot = temp.make("openclaw-plugin-artifact-");
    const stagingRoot = path.join(packageRoot, "dist-runtime", "extensions", "fixture");
    const canonicalRoot = path.join(packageRoot, "dist", "extensions", "fixture");
    const stagingSource = path.join(stagingRoot, "index.js");
    const canonicalSource = path.join(canonicalRoot, "index.js");
    write(stagingSource, "export const revision = 'staging-1';\n");
    write(canonicalSource, "export const revision = 'canonical-1';\n");
    const record = {
      pluginId: "fixture",
      origin: "bundled" as const,
      rootDir: stagingRoot,
      source: stagingSource,
    };
    const first = fingerprintPluginRuntimeArtifact(record);

    write(stagingSource, "export const revision = 'staging-2';\n");
    expect(fingerprintPluginRuntimeArtifact(record)).toBe(first);

    write(canonicalSource, "export const revision = 'canonical-2';\n");
    expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(first);
  });

  it("hashes source when a bundled plugin opts out of core dist", () => {
    const rootDir = temp.make("openclaw-plugin-artifact-");
    const source = path.join(rootDir, "index.ts");
    const staleDistSource = path.join(rootDir, "dist", "index.js");
    write(source, "export const revision = 'source-1';\n");
    write(staleDistSource, "export const revision = 'stale-1';\n");
    const record = {
      pluginId: "fixture",
      origin: "bundled" as const,
      rootDir,
      source,
      packageBuild: { bundledDist: false },
    };
    const first = fingerprintPluginRuntimeArtifact(record);

    write(staleDistSource, "export const revision = 'stale-2';\n");
    expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(first);

    const afterStaleChange = fingerprintPluginRuntimeArtifact(record);
    write(source, "export const revision = 'source-2';\n");
    expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(afterStaleChange);
  });
});
