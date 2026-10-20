import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStandaloneCompiler,
  assertStandalonePlatform,
  createStandaloneManifest,
  describeStandaloneRuntime,
  parseStandaloneArguments,
  relativeStandaloneEntry,
  resolveStandaloneBuildIdentity,
} from "../../scripts/lib/bun-standalone-contract.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.10.3";
const parse = (...flags: string[]) => parseStandaloneArguments(["out", ...flags]);
const identity = (info: Parameters<typeof resolveStandaloneBuildIdentity>[0]) =>
  resolveStandaloneBuildIdentity(info, version);
function fixture() {
  const root = tempDirs.make("openclaw-standalone-contract-");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime);
  return { root, runtime };
}

describe("standalone build interface", () => {
  it("defaults to JIT and selects exactly one explicit compilation mode", () => {
    expect(parse()).toEqual({
      outputDirectory: "out",
      mode: "jit",
      compileFlags: [],
    });
    for (const [flag, mode] of Object.entries({
      "--bytecode": "bytecode",
      "--compile-aot": "aot",
    })) {
      const parsed = parse(flag);
      expect(parsed).toMatchObject({ mode });
    }
    expect(() => parse("--bytecode", "--compile-aot")).toThrow("at most one");
    expect(() => parse("--unknown")).toThrow("at most one");
    expect(() => parseStandaloneArguments([])).toThrow("Usage:");
  });

  it("accepts one plugin list independently of the compilation mode", () => {
    for (const flags of [
      ["--plugins", "codex, slack,codex", "--bytecode"],
      ["--bytecode", "--plugins", "codex,slack"],
    ]) {
      expect(parse(...flags)).toEqual({
        outputDirectory: "out",
        mode: "bytecode",
        compileFlags: ["--bytecode"],
        pluginIds: ["codex", "slack"],
      });
    }
    for (const flags of [
      ["--plugins"],
      ["--plugins", ""],
      ["--plugins", "codex,"],
      ["--plugins", "--bytecode"],
      ["--plugins", "codex", "--plugins", "slack"],
    ]) {
      expect(() => parse(...flags)).toThrow("--plugins");
    }
  });

  it("refuses experimental AOT on a compiler without that capability", () => {
    expect(() =>
      assertStandaloneCompiler("aot", "--compile  Build an executable\n--bytecode  Cache bytecode"),
    ).toThrow("Use the default JIT mode or --bytecode");
    expect(() =>
      assertStandaloneCompiler("aot", "  --compile-aot  Compile native code"),
    ).not.toThrow();
  });

  it("limits standalone artifacts to supported build hosts", () => {
    expect(() => assertStandalonePlatform("darwin")).not.toThrow();
    expect(() => assertStandalonePlatform("linux")).not.toThrow();
    expect(() => assertStandalonePlatform("win32")).toThrow(
      "Build on macOS or Linux; Windows standalone artifacts are not supported yet.",
    );
  });

  it.each([
    ["/build/runtime", "/build/runtime/dist/worker.js", "dist/worker.js"],
    ["/build/runtime", "/build/runtime/dist/../worker.js", "worker.js"],
    ["/build/runtime", "/build/runtime-other/dist/worker.js", undefined],
    ["/build/runtime", "/build/runtime/../worker.js", undefined],
    ["/build/runtime", "/build/runtime", undefined],
    ["/build/runtime", "dist/worker.js", undefined],
  ])("maps contained runtime paths to POSIX entry keys (%s, %s)", (root, filename, expected) => {
    expect(relativeStandaloneEntry(root, filename)).toBe(expected);
  });

  it("normalizes canonical runtime provenance", () => {
    expect(
      identity({ version, commit: "A".repeat(40), builtAt: "2026-10-14T00:00:00.000Z" }),
    ).toEqual({ version, commit: "a".repeat(40) });
  });

  it.each([
    undefined,
    { version: "", commit: "a".repeat(40) },
    { version, commit: null },
    { version, commit: "abc123" },
    { version: "2026.10.2", commit: "a".repeat(40) },
  ])("refuses missing, invalid, or mixed runtime provenance (%s)", (buildInfo) => {
    expect(() => identity(buildInfo)).toThrow("Run pnpm build");
  });

  it("describes the executable and deterministic sidecar without following links", async () => {
    const { root, runtime } = fixture();
    const sqlite = {
      source: "bun",
      version: "3.53.4",
      extensionLoadingSupported: true,
      compileOptions: ["ENABLE_FTS5"],
      license: "public-domain",
    };
    fs.writeFileSync(path.join(root, "openclaw"), "standalone\n");
    fs.writeFileSync(path.join(runtime, "a.js"), "export const value = 7;\n");
    fs.symlinkSync("a.js", path.join(runtime, "link"));
    const manifest = await createStandaloneManifest({
      outputRoot: root,
      mode: "jit",
      bun: { version: "1.4.3", revision: "1.4.3+fixture", executableSha256: "a".repeat(64) },
      openclaw: { version: "2026.10.3", commit: "b".repeat(40) },
      embedded: { modules: 4, plugins: 1, workers: 2, inlineWorkers: 0 },
      packageManager: undefined,
      plugins: { embedded: ["slack", "codex"], omitted: ["signal", "matrix"] },
      sqlite: structuredClone(sqlite),
      pruning: {
        categories: { pluginAssets: { files: 1, bytes: 24 } },
        sidecarPlugins: [],
      },
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      mode: "jit",
      executable: { path: "openclaw", sizeBytes: 11 },
      runtime: {
        path: "runtime",
        sizeBytes: 24,
        fileCount: 1,
        symlinkCount: 1,
        categories: { pluginAssets: { files: 1, bytes: 24 } },
        sidecarPlugins: [],
        sqlite,
      },
      embedded: { modules: 4, plugins: 1, workers: 2, inlineWorkers: 0 },
      plugins: { embedded: ["codex", "slack"], omitted: ["matrix", "signal"] },
    });
    expect(manifest.runtime.sha256).toBe(
      "c1763658d97365c3501098c7326f9a049ec6107223baaea9f96cdb19e7c6cf9a",
    );
    fs.writeFileSync(path.join(runtime, "a.js"), "changed\n");
    expect((await describeStandaloneRuntime(runtime)).sha256).not.toBe(manifest.runtime.sha256);
  });

  it.each(["dangling", "outside", "indirect-outside", "cycle", "absolute-inside"])(
    "rejects a %s runtime symlink before describing the sidecar",
    async (kind) => {
      const { root, runtime } = fixture();
      const outside = path.join(root, "outside");
      fs.writeFileSync(outside, "outside\n");
      const link = path.join(runtime, "node_modules/.pnpm/node_modules/openclaw-control-ui");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      const asset = path.join(runtime, "asset");
      fs.writeFileSync(asset, "asset\n");
      const target =
        kind === "dangling"
          ? "../../../ui"
          : kind === "cycle"
            ? path.basename(link)
            : kind === "absolute-inside"
              ? asset
              : path.relative(path.dirname(link), outside);
      if (kind === "indirect-outside") {
        const bridge = path.join(runtime, "bridge");
        fs.symlinkSync("../outside", bridge);
        fs.symlinkSync(path.relative(path.dirname(link), bridge), link);
      } else {
        fs.symlinkSync(target, link);
      }
      await expect(describeStandaloneRuntime(runtime)).rejects.toThrow(
        "Invalid standalone runtime symlink",
      );
    },
  );

  it("allows contained directory links without counting their contents twice", async () => {
    const { runtime } = fixture();
    fs.mkdirSync(path.join(runtime, "assets"));
    fs.writeFileSync(path.join(runtime, "assets", "data"), "data");
    fs.symlinkSync("assets", path.join(runtime, "asset-link"));
    expect(await describeStandaloneRuntime(runtime)).toMatchObject({
      fileCount: 1,
      symlinkCount: 1,
      sizeBytes: 4,
    });
  });
});
